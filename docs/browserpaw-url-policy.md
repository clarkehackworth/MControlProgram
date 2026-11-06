# Spec: URL access policy for BrowserPaw (plus scheme hardening for both plugins)

Status: agreed design, 2026-11-06. Fork-only (`clarkehackworth/browserpaw`); not shaped for upstream.
Touches the browserpaw fork (extension + native server) and MControlProgram (`src/plugins/browserpaw`, `src/plugins/web`, `web/src/plugins`).

## Decisions

| Topic | Decision |
|---|---|
| List scope | One browser list shared by **all profiles**, separate from the web plugin's list |
| Sync failure | **Fail closed**, including headed browsers (user's manual browsing is blocked too until in sync) |
| DNS / resolved IPs | Out of scope. Browser rules match hostnames only; best effort |
| External app handlers (`ssh:`, `vscode:`, `mailto:` …) | Blocked in tool args and nav guard on a best-effort basis; no Chromium managed-policy hardening |
| Agent attribution | MControlProgram passes the caller identity to the extension on every tool call; tabs keep an owner; child tabs inherit it; every logged event carries it |
| Upstream | Fork only |

## Already done (web plugin, this change)

- **Trailing-dot bypass fixed.** `new URL('https://evil.com./').hostname` is `evil.com.`, which used to slip past `domain: evil.com` and `url: https://evil.com/` rules (and `localhost.` past the private check). `checkUrl` now canonicalizes the hostname, `ruleMatches` strips trailing dots, and `normalizeBlock` strips them from domain rules.
- **Non-http schemes are logged.** `file:`, `ftp:`, `ssh:` etc. are still refused, but they're now recorded in `web_requests` with `blocked = 'scheme: <proto>'`, including redirects to them.
- Tests: `test/web-blocks.test.ts`.

## Architecture

```
MControlProgram (owner of rules + log)
   │  HTTP over the existing ssh tunnel / manual bridge, bearer token
   ▼
BrowserPaw native server (fastify, 127.0.0.1:12306-12316)  — stateless relay
   │  native messaging
   ▼
Extension service worker
   ├─ declarativeNetRequest dynamic rules  ← enforcement (all request types)
   ├─ webNavigation guard                  ← non-network schemes (file:, chrome:, external handlers)
   ├─ tab owner map                        ← which agent each tab belongs to
   └─ event ring (chrome.storage.session)  → pulled by MControlProgram
```

The policy API is plain HTTP on the native server, **not** MCP tools. MControlProgram's tool proxy forwards every upstream tool to agents, so anything exposed as a tool would let agents rewrite their own rules.

## 1. Shared policy module (MControlProgram)

Move `Rule`, `BlockKind`, `RuleAction`, `Policy`, `ruleMatches`, `verdict`, `normalizeBlock` and `label` from `src/plugins/web/index.ts` to `src/core/url-policy.ts`, and add:

- `checkScheme(u, 'fetch' | 'browser')` → `{ blocked?: string }` using the table in §3. The web plugin's inline http/https check becomes a call to this.
- `canonicalHost(h)` (the trailing-dot strip, now inline in the web plugin).
- RE2 check in `normalizeBlock('regex', …)` when `scope === 'browser'`: reject `(?=`, `(?!`, `(?<=`, `(?<!` and `\1`–`\9` with "the browser's regex engine (RE2) does not support lookaround/backreferences". The extension also runs `isRegexSupported` and reports rejects (see §4).

The web plugin keeps its own table; no behaviour change.

## 2. MControlProgram: browserpaw plugin side

### Storage

```sql
CREATE TABLE browserpaw_rules (id INTEGER PRIMARY KEY, action TEXT NOT NULL DEFAULT 'block', kind TEXT NOT NULL, value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value));
CREATE TABLE browserpaw_policy (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- 'default' -> allow|deny, 'rev' -> integer
CREATE TABLE browserpaw_requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, profile TEXT NOT NULL,
  principal TEXT, session_id TEXT, agent_via TEXT,      -- tool | inherited | inferred | NULL (unattributed / user)
  tab_id INTEGER, type TEXT NOT NULL,                   -- main_frame | sub_frame | xmlhttprequest | websocket | navigation | ...
  method TEXT, url TEXT NOT NULL, host TEXT NOT NULL, blocked TEXT, allowed_by TEXT, initiator TEXT,
  via TEXT NOT NULL);                                   -- dnr | nav-guard | tool-arg | dropped
CREATE INDEX browserpaw_requests_ts ON browserpaw_requests(ts);
```

`rev` is bumped on every rule or policy change and is the sync version.

### Actions

`globalActions`, mirroring the web plugin: `rules`, `rule`, `delete_rule`, `set_policy`, `requests` (adds `profile`, `principal`, `type` filters), `clear_requests`, plus `sync_status` (per profile: ack'd rev, last pull, last error, rejected rules).

### Sync (one list → every connected profile)

- **On connect** (in `client()` after `connectBridge()`): `PUT /url-policy` `{ rev, policy, rules, schemes, logAllowed }`, then wait for the ack `{ rev, installed, rejected: [{id, error}] }` before forwarding any tool call.
- **On change**: push to every connected profile right away.
- **Heartbeat** (about every 15 s, on the existing status timer): `GET /url-policy/state` → `{ rev }`. If it doesn't match, push again.
- **Fail closed**: if a profile's ack'd rev ≠ current rev, tool calls to it return `browser policy not in sync for profile X`.
- **Extension bootstrap**: with no stored policy, the extension installs a block-everything rule. DNR dynamic rules survive browser restarts, so a restarted browser enforces the last list until the next push replaces it.
- Manual hosts use the same calls through `bridgeFetch`.

### Passing the agent identity (attribution)

In the proxy `handler(args, call)`, strip any agent-supplied `_meta` and set our own:

```ts
const { profile, _meta: _ignored, ...rest } = args ?? {};
rest._meta = { mcp: { principal: call.principal ?? null, sessionId: call.sessionId ?? null } };
```

This must be **in the arguments**, not `params._meta`. The native server does `rawArgs._meta || params._meta` (`register-tools.ts:172`), so arguments win, and an agent could otherwise spoof the identity. It is only trustworthy because MControlProgram overwrites it and agents can't reach the bridge directly (the bridge token is never exposed).

The tool-arg pre-check and the pulled events both carry `principal`/`session_id`. Optionally add the MCP `clientInfo.name` from the session if `Caller` exposes it later.

### Tool-argument pre-check

Before forwarding, check URL arguments of known URL-taking tools (`chrome_navigate`, `chrome_network_request`, URLs in `chrome_batch_actions` steps, `chrome_bookmark_add`) with `checkScheme(u, 'browser')` and `verdict()`. On a block, log it (`via='tool-arg'`) with the caller and return a clear error. This gives clean errors; DNR is the actual enforcement.

### Event pull

`GET /url-policy/events?after=<seq>&limit=1000` every ~3 s while the profile is connected, plus once on disconnect. Insert into `browserpaw_requests`. Prune with the same `logRetentionDays` sweep as `web_requests`.

### Agent-facing tool

`{prefix}_policy` (read only): default policy plus rules, so agents can stop retrying blocked URLs.

### UI

Generalise `web/src/plugins/WebTraffic.tsx` to `<AccessRules pluginId="web" | "browserpaw" />`; the action prefix comes from props. Browserpaw extras:
- log columns for profile, agent (principal + `agent_via` badge: tool / inherited / inferred / user), type and via
- allowed subresources hidden by default
- a sync badge per profile (in sync / pending / error, with rejected rules listed)

Mount it in `PluginPage.tsx` for `p.id === 'browserpaw'`. The client-side `verdict()` mirror in `WebTraffic.tsx` gets the same trailing-dot strip.

## 3. Scheme policy (both plugins)

One table in `url-policy.ts`; the browser part is pushed to the extension as `schemes`.

| Scheme | web plugin | browser | Notes |
|---|---|---|---|
| `http:` `https:` | rules apply | rules apply | |
| `ws:` `wss:` | refused | rules apply | DNR covers `websocket` |
| `file:` | refused (logged) | **blocked** | Nav guard; extension file-URL access must stay off |
| `ftp:` | refused (logged) | blocked | |
| `chrome:` `chrome-untrusted:` `devtools:` `edge:` | refused | blocked except `chrome://newtab` | settings/extensions/flags/inspect are escapes |
| `chrome-extension:` | refused | only BrowserPaw's own ID (+ the PwnFox theme extension) | |
| `about:` | refused | `about:blank`, `about:srcdoc` only | |
| `view-source:` | refused | inner URL checked | prevents `view-source:file:///…` |
| `blob:` `filesystem:` | refused | allowed if the inner origin passes the rules | |
| `data:` | refused | subresource OK; top-level navigation blocked | |
| `javascript:` | refused | blocked in tool args | in-page JS is gated by `allowTools` |
| anything else (`ssh:`, `telnet:`, `mailto:`, `smb:`, `vscode:`, `ms-*:` …) | refused | blocked (best effort) | tool args + nav guard; no host policy hardening |

Browser enforcement of non-network schemes: the tool-arg pre-check, then a `webNavigation.onBeforeNavigate` guard that redirects the tab to a blocked page and reports it. The guard is racy (a frame may render), which is accepted as best effort.

## 4. BrowserPaw fork changes

### Manifest (`app/chrome-extension/wxt.config.ts`)
Add `declarativeNetRequest` and `declarativeNetRequestFeedback`. `onRuleMatchedDebug` works because the extension is loaded unpacked. `webNavigation` and `webRequest` are already present.

### Native server (`app/native-server/src/server/index.ts`)
Routes behind the existing token `preHandler`, each relaying via `sendRequestToExtensionAndWait`:
- `PUT /url-policy` → `url_policy_set`
- `GET /url-policy/state` → `url_policy_state`
- `GET /url-policy/events?after&limit` → `url_policy_events`

The native server keeps no state.

### Extension: policy (`entrypoints/background/url-policy.ts`, new; wired in `background/index.ts` and the `native-host.ts` message switch)

DNR tiers (higher priority wins; `allow` beats `block` at equal priority, so tiers must not overlap):

| Tier | Priority | Rule |
|---|---|---|
| scheme blocks / bootstrap block-all | 100 | |
| user `block` | 50 | `block` |
| user `allow` | 40 | `allow` (only when policy = deny) |
| default deny | 1 | `{ urlFilter: '*' }` → `block` when policy = deny |

- **domain** → `requestDomains: [d]`. This covers subdomains, and Chrome canonicalizes trailing dots.
- **url prefix** → `urlFilter: '|' + escaped`. Escape `*` `^` `|`. Origin-only input is normalized to `https://a.com/` so it can't match `a.com.evil.net`.
- **regex** → `regexFilter`, `isUrlFilterCaseSensitive: false`, checked with `isRegexSupported`. Rules that fail come back in `rejected`.
- `resourceTypes`: list all types, including `main_frame`.
- DNR id = tier offset + MControlProgram rule id, so matches map back to a label.
- Apply atomically: one `updateDynamicRules({ removeRuleIds: all, addRules })`, then store `rev` in `chrome.storage.local`. Reject over-limit pushes as a whole (about 30k rules, about 1k regex).
- `ruleMatches`/`verdict` are ported to `packages/shared` (about 20 lines) to compute `allowed_by` for logged allows. A shared fixture JSON is tested in both repos.

### Extension: agent attribution (tab ownership)

State lives in `chrome.storage.session` (survives service-worker restarts, cleared on browser restart): `tabOwner: Map<tabId, { principal, sessionId, via, since }>`.

| Event | Effect |
|---|---|
| Tool call with `args.tabId` | before execute: owner(tabId) = caller, `via: 'tool'` |
| Tool call returns a tab (`targetTabId` in `tools/index.ts`, already computed) | owner(targetTabId) = caller, `via: 'tool'` |
| `tabs.onCreated` while exactly one agent has a call in flight | owner(new tab) = that caller, `via: 'tool'`. Covers `chrome_navigate` opening a new tab, so the first request is already attributed |
| `webNavigation.onCreatedNavigationTarget` (window.open, `target=_blank`, ctrl-click) | owner(child) = owner(sourceTabId), `via: 'inherited'` |
| `tabs.onCreated` with `openerTabId` (fallback) | same, `via: 'inherited'` |
| Request in an unowned tab while exactly one agent's call is in flight | attributed to that caller, `via: 'inferred'`; the tab is not claimed |
| `tabs.onRemoved` / `onReplaced` | delete / move the entry |

- Every request in an owned tab (subresources, link clicks, redirects, JS navigations) is logged with that owner. This is the "same tab inherits" requirement.
- Last writer wins: if agent B drives a tab agent A opened, the tab becomes B's.
- `tabId -1` (service workers, prefetch, extension-originated) → unattributed. Same for tabs no agent touched (the user's own browsing): `agent_via = NULL`, shown as "user" in the UI.
- In-flight tracking: `handleCallTool` adds `{ requestId, caller }` to an in-flight set on entry and removes it in `finally`. If several different callers are in flight at once, the "exactly one" rules don't fire, so nothing is guessed.
- `_meta.mcp` is removed from `args` before `tool.execute`, so tools never see it.

### Extension: reporting

- blocked: `onRuleMatchedDebug` → `{ seq, ts, tabId, type, method, url, initiator, blocked: label(ruleId), via: 'dnr', principal, sessionId, agentVia }`
- allowed: `webRequest.onBeforeRequest` (observe only) filtered by the pushed `logAllowed: 'navigation' | 'all' | 'none'` (default `navigation` = `main_frame`, `sub_frame`, `websocket`) → `allowed_by` from the shared `verdict()`
- nav-guard blocks: `via: 'nav-guard'`
- ring of about 5k events in `chrome.storage.session` with a monotonic `seq`. On overflow, emit a `{ via: 'dropped', count }` event so the log shows the gap.

### Self-protection
- The policy and the owner map change only through native-messaging messages (`url_policy_*`) and the extension's own listeners. There is no MCP tool, popup control or content-script message path to them. Add a test asserting no tool handler references `declarativeNetRequest` or `url_policy`.
- The popup shows the policy read-only (rev, rule count, in sync).

## Remaining caveats

- **Headed browsers:** once an agent has driven a tab, the user's manual clicks in that tab are attributed to the agent. The `agent_via` badge and tab id make this visible; it is not fixed.
- **Burp/PwnFox:** DNR blocks before the proxy, so blocked attempts never appear in Burp history, only in the MControlProgram log.
- **Log volume:** `logAllowed: 'all'` produces thousands of rows per page. Keep the default at `navigation`.
- **Regex parity:** rules valid in the web plugin may be rejected by the browser list. They are separate lists, so this only matters when copying rules between them.

## Test plan

- `test/url-policy.test.ts`: scheme table, trailing dots, `view-source:`/`blob:` unwrapping, prefix footgun, RE2 rejection.
- The shared fixtures run against `packages/shared` in the fork.
- Proxy: an agent-supplied `_meta` is overwritten; a profile out of sync refuses calls.
- Extension unit tests for tab ownership: a tool tags its tab, `window.open` child inherits, two concurrent callers → no inference, tab removed → entry gone.
- End-to-end against a local profile, with deny policy and two principals:
  - each navigates in its own tab; an allowed URL, a blocked URL, an iframe of a blocked domain, `fetch()` from `chrome_javascript`, a `target=_blank` link, `file:///etc/passwd`, `ssh://x`, `view-source:file:///`
  - assert each row in `browserpaw_requests` has the right principal, `agent_via` and `via`
- Sync: restart the browser with a stale rev → tool calls refused until the re-push.
