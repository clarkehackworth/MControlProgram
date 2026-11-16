# MControlProgram plugin API

A plugin is an ES module whose **default export** implements `MControlProgramPlugin`
(`src/core/plugin-api.ts`). MControlProgram instantiates it once per *plugin instance*
(a plugin added to a specific MCP server with its own config).

## The boundary

- `src/core/plugin-api.ts` is the **only** core module a plugin imports (types, plus the helpers `text`,
  `errorResult`, `ask`, `effective`, `safeRegex`). Everything stateful reaches the plugin through `init(host)`
  and the contexts below. Built-ins follow the same rule as external plugins.
- The core knows no plugin by id: built-ins are found by scanning `src/plugins/`, and the admin UI gets each
  plugin's own screens from its `ui.js` (see [Admin UI](#admin-ui)).
- Plugins don't share code, except through a **declared** dependency's `api` (and, at build time, its
  types; in the UI, its `ui.js`).

## `init(host)`

```ts
init(host) { /* keep it: */ h = host; }
// host.db          shared SQLite database; name your tables `<plugin id>_…`
// host.kv          get/set settings private to the plugin (stored as `<plugin id>.<key>`)
// host.secrets     encrypt/decrypt with MControlProgram's data key (secrets kept outside the config)
// host.config()    current decrypted plugin-wide config, defaults applied (read at use time)
// host.callbackUrl() URL that runs the plugin's `callback` global action (OAuth redirects)
// host.global()    MControlProgram-wide defaults;  host.log;  host.dep(id) as below
```

Called once per load, after dependency checks, dependencies first.

```ts
export default {
  id: 'ssh',                 // [a-z][a-z0-9_-]* ; default tool prefix
  name: 'SSH', version: '1.0.0', description: '…',
  navOrder: 10,                         // optional: sidebar position (ascending; unset = after, by name)
  configSchema: { type: 'object', properties: { … } },   // JSON Schema → UI form
  defaultConfig: { … },
  create(ctx) { return { tools: [ … ], start, stop, status, actions, resources, onSessionClosed }; },
};
```

## Config schema conventions

| Keyword | Effect |
|---|---|
| `"x-secret": true` on a string | Encrypted at rest, decrypted only into `ctx.config`, shown as `••••••••` in the UI. Works inside arrays/objects. |
| `format: "multiline"` | Textarea (PEM keys, scripts). |
| `enum` | Select box. |
| `title`, `description`, `default` | Labels / help / initial values. |
| `type: array, items: {type: object}` | Repeating cards with add/remove. |
| `additionalProperties: {type: string}` | Key/value editor. |

## Two levels of config

| Level | Field | Edited where | Typical content |
|---|---|---|---|
| Plugin-wide | `globalConfigSchema` / `defaultGlobalConfig` | Plugins page → Configure | Inventory shared by all instances: SSH hosts, API credentials |
| Per instance | `configSchema` / `defaultConfig` | Server → Plugins tab | What this MCP server exposes: selected names, isolation, limits |

Instance schemas select from the inventory with `"x-options-from": "<array key in global config>"`
on a string (select) or array-of-strings (checkbox list) field; the UI offers the `name` of each
entry. `"x-show-if": { "auth": "key" }` hides a field unless a sibling has that value (a list of values is accepted too: `{ "auth": ["bearer", "header"] }`).

Saving plugin-wide config restarts every instance of that plugin on every server.

### Plugin-wide actions and wizards

```ts
globalActions: {
  add_host: { title: 'Add host', async run(params, a) { /* a.config, await a.setConfig(next), a.log */ } },
}
```

Actions run server-side with the decrypted plugin config and can persist changes with
`setConfig` (secrets are encrypted at rest). Keep each action **stateless**: a multi-step wizard is
a sequence of independent actions keyed by names, so a browser refresh or retry never breaks it.
The ssh plugin's wizard is `add_host` → optional `copy_id` → `test_host`; generated private keys
are stored by the action and only the public key is returned.

The UI renders generic action buttons for every global action, except ones marked `hidden: true`
(internal actions, or ones the plugin's own UI calls). A plugin that needs a richer flow ships an
admin UI (below).

## `create(ctx)` → `PluginInstance`

```ts
interface PluginContext { instanceId; instanceName; serverId; config; pluginConfig; global: () => GlobalConfig; log: ScopedLogger; serverUrl?(): string }
// serverUrl() = the base URL agents reach this MCP server at (its Public URL, else http://host:port).
// config = this instance's decrypted config; pluginConfig = decrypted plugin-wide config (shared inventory).
// GlobalConfig = { stateIdleSec, connectionIdleSec, logRetentionDays } — MControlProgram-wide defaults set in the UI.
// Call ctx.global() at use time (inside your reaper), not once at create, so admin changes apply live.

interface PluginInstance {
  tools: ToolDefinition[];            // required
  resources?: ResourceDefinition[];   // MCP resources
  start?(): void | Promise<void>;     // open pools, timers
  stop?(): void | Promise<void>;      // MUST release connections; called on reconfigure/stop
  onSessionClosed?(sessionId): void;  // agent disconnected — drop per-session state
  status?(): object;                  // shown in UI
  actions?: { [key]: { title, run(params) } };  // admin buttons in UI
  http?(req, res, ctx: HttpContext): void | Promise<void>;
  // requests to <server>/plugins/<tool prefix>/… on the MCP port, req.url = the rest, raw body unread.
  // No MCP auth is applied: authenticate them yourself. ctx.ask(principal, tool, spec, signal) = ToolCallContext.ask.
}
```

### Tools

```ts
{
  name: 'exec',                              // exposed as `<instanceName>_exec`
  description: '…',                          // what the agent reads
  inputSchema: { host: z.string(), command: z.string() },   // zod raw shape (zod is a peer of the sdk)
  annotations: { readOnlyHint: true },
  async handler(args, call) {                // call: { sessionId, principal, signal, log }
    return { content: [{ type: 'text', text: '…' }], isError: false, structuredContent: { … } };
  },
}
```

Throwing from a handler is converted to an `isError` result and logged. Honour `call.signal`
for long operations. Use `call.log.connection(msg, data, call.sessionId)` for events that should
appear at the `connections` log level, `call.log.info/debug` for the rest (filtered by the server's
log level), `warn/error` always persisted.

## Design rule: every tool call is self-contained

Agents retry, run tools in parallel, lose context, and reconnect. Do **not** make a tool depend on
the result of an earlier call (no "open → get handle → use handle" sequences):

- Address state by **stable names the agent already knows** from config or a list tool
  (`host`, `name`), never by handles your plugin minted in a previous call.
- **Open on demand**: if the addressed resource does not exist, create it inside the call.
- Make close/disconnect **idempotent** and let everything reopen on the next call.
- Scope state to the caller: `call.principal` identifies the token/OAuth client, `call.sessionId`
  the MCP session. Default to principal scoping so agents cannot reach each other's state and a
  reconnecting agent resumes its own; offer `session` / `shared` as config if it makes sense.
- Reap your own state: run an idle timer from `start()` (and clear it in `stop()`) so resources
  an agent never closed are still released. Implement `onSessionClosed` for session-scoped state.
- Use the MControlProgram-wide timeouts by default: `effective(cfg.myIdleSec, ctx.global().stateIdleSec)`
  from `plugin-api` returns the instance override when > 0, else the global. Document the
  override field as "0 = use the MControlProgram-wide value". Use `stateIdleSec` for per-agent state and
  `connectionIdleSec` for sockets/pools that can be reopened transparently.

Both built-ins follow this: the `web` plugin's cookie jar is keyed by scope and consulted inside
every request, and `shell_send {host, name, input}` opens the shell if
needed, so the same call works first or hundredth, in any order.

## Lifecycle

- Server start → `create` + `start` for every enabled instance.
- Instance config saved in UI → `stop` old instance, `create` + `start` new one; connected agents
  receive `tools/list_changed`.
- Server stop / instance disabled / deleted → `stop`.
- **Reload plugins** in UI → re-imports all plugin modules and restarts every instance.

## Loading

1. Built-ins: every directory under `src/plugins/`.
2. `data/plugins/<dir>/` — directory with `package.json` (`main`) or `index.js`.
3. Directories in `MCONTROLPROGRAM_PLUGIN_DIRS` (colon separated).
4. npm package names listed under **Plugins → npm packages** (must be resolvable from MControlProgram's `node_modules`).

Plugins run **in-process** and are trusted code. Import `zod` from your own dependencies or rely on
MControlProgram's (`import { z } from 'zod'`).

See `examples/echo-plugin` for a complete minimal plugin and `src/plugins/ssh` for a full one
(connection pooling, idle disconnect, per-session cleanup, actions).

## Dependencies and versions

A plugin can build on another one. Declare it with a semver range and reach its `api` through `ctx.dep()`:

```ts
import type { SshApi } from '../ssh/index.js';
export default {
  id: 'browserpaw', version: '0.1.0',
  dependencies: { ssh: '^0.2.0' },          // id → range: ^ ~ >= > <= < exact *, space = AND, || = OR
  create(ctx) { const ssh = ctx.dep<SshApi>('ssh'); /* ... */ },
  globalActions: { check: { title: 'Check', async run(p, a) { await a.dep<SshApi>('ssh').exec('box', 'true', a.log); } } },
};
```

- A plugin whose dependencies are missing or out of range is **not loaded**, and neither is anything that depends on it. The reason shows on the Plugins page after a reload.
- `ctx.dep(id)` (also `a.dep`, `host.dep`) throws for a plugin you did not declare, so dependencies stay explicit.
- `optionalDependencies` (same format) are used when present: `dep(id)` returns `undefined` when that plugin is
  missing or out of range (the Plugins page notes the version mismatch), and the plugin still loads.
  `mcp` uses `ssh` this way to reach upstream servers through an SSH host.
- Import a dependency's *types* only (`import type { SshApi } from '../ssh/index.js'`); values come from `dep()`.
- The provider exports what it offers as `api` on its plugin object, and bumps `version` when that changes (semver: a breaking change bumps the major version, or the minor version while it is 0.x).
- Built-in providers: `mcp@0.2.0` exposes `McpApi` (`toolRuleStore(db, prefix, { defaultPolicy })`: per-group, per-tool allow/ask/deny rules, a default policy, a call log and `gate()`, in the caller's own `<prefix>_rules` / `_tools` / `_policy` / `_calls` tables, with the admin actions; its UI exports the `ToolRules` panel). git uses it. `web@0.2.0` exposes `WebApi`, its URL rule engine (`ruleStore(db, prefix)` keeps a separate
  rule list in the caller's own `<prefix>_blocks` / `<prefix>_policy` tables, with the admin actions the rules
  UI uses, including `check` for server-side verdicts; plus `verdict`, `ruleMatches`, `normalizeBlock`).
  browserpaw keeps its browser list this way. `ssh@0.2.2` exposes `SshApi` (`hostNames`, `exec` (optional stdin `input` since 0.2.1), `spawn` (streaming binary stdin/stdout, since 0.2.2), `openTunnel`). It only works with hosts that have a pinned host key. Hosts with auth `native` need no pin: they run on the MControlProgram machine itself (exec and shells via the local shell, SFTP via the local filesystem, `openTunnel` returns the port as is). Agents given a native host get this machine's privileges, including MControlProgram's own data, so restrict it with command patterns and an SFTP root. Shells have no pty.
- An inventory field can offer another plugin's inventory as a dropdown with `'x-options-from': '<pluginId>:<key>'`, for example `'ssh:hosts'`.
- The "Used by" column (server toggles + Pair server) appears only on inventories that an instance config selects from (`x-options-from`). An inventory that other inventory items point at by name can say so with `'x-referenced-by': { inventory, field, title }`; its table then lists those items instead (and the delete confirmation warns about them).
- `x-no-column: true` on an inventory field keeps it in the edit form but out of the table.
- A global action with `inventory: '<key>'` only shows as a row button on that inventory table.

## Admin UI

A plugin can ship `ui.js` next to its entry module (built-ins: `src/plugins/<id>/ui/index.tsx`, built to
`dist/plugins/<id>/ui.js` by `npm run build:web`). The app imports it at runtime from `/api/plugins/<id>/ui.js`.
Its default export is a `PluginUi` (`web/src/plugin-ui.ts`); every slot is optional:

| Slot | Where it shows |
|---|---|
| `Page` | The plugin's page, under its inventories (logs, rules…). Props: `plugin`, `selected` |
| `inventory[key].AddButton` / `EditExtra` / `Delete` | A guided add flow, extras in the edit dialog, a custom delete flow |
| `inventory[key].selectable` | Rows are clickable; the chosen one is highlighted and passed to `Page` as `selected[key]` (first item by default) |
| `asks.RuleDialog`, `asks.direct` + `asks.setRule` | "Add allow/block rule…" for this plugin's asks; or a one-switch rule with no dialog |

Bundle it as an ES module with `react`, `react/jsx-runtime` and `@mcontrolprogram/ui` external, mapped to
`/sdk/react.js`, `/sdk/jsx-runtime.js` and `/sdk/ui.js`: the app's own module instances, so hooks and styles
just work. `@mcontrolprogram/ui` (`web/src/sdk/ui.ts`) is the UI half of the plugin API: the API client
(`api`, `useApi`), the shared components (`Modal`, `Field`, `Alert`, `RuleGroup`, `PendingAsks`, `SchemaForm`…)
and the `PluginUi` types. A plugin may import a declared dependency's UI as `@plugin/<id>` (mapped to
`/api/plugins/<id>/ui.js`); browserpaw reuses web's rules panel that way. `web/build-plugin-ui.mjs` builds
each plugin separately and fails if a bundle imports anything else.

## Built-in: ssh command log and rules

The SSH plugin page has **Command rules** and a **Command log**, like the Web plugin's access rules and request log. Every agent `exec`, `shell_send` and `sftp_*` call is logged (host, agent, command or path, exit code, time; never output), pruned after the global log retention.

Rules live in their own tables (`ssh_rules`, `ssh_policy`), apply live to every SSH instance without restarts, and only to agent `exec` / `shell_send` (not to `SshApi` calls from other plugins such as browserpaw). Command lines are parsed with tree-sitter-bash (`src/plugins/ssh/shell-parse.ts`) into every command they run: pipelines, lists, subshells, `if`/`for` bodies, `$( )` and backticks, commands behind wrappers (`sudo`, `env`, `xargs`, `timeout`, `find -exec`…), and the contents of `sh -c "…"`, `su -c`, `eval` and `ssh host "…"`, recursively. Output redirects (`>`, `>>`, `&>`) are collected as written files. Rule kinds: **program** (by basename), **prefix** (a command starting with it, whole words), **regex** (each command; block rules also the whole line) and **write** (redirect target path prefix, whole components; `/dev/null` always allowed), each for all hosts or one. Block rules win. Under deny by default every command and written file needs an allow rule, and lines that can't be fully analysed are refused: a program, `-c` script or output file built from `$VAR`/`$( )`, a shell reading commands from stdin or a script file, syntax errors. The host's own `allowCommands` / `denyCommands` patterns are checked after. It's a guardrail, not a sandbox: interpreters (`python -c`, `perl -e`, `node`…), programs that write files themselves (`cp`, `tee`, `sed -i`) and scripts on disk aren't looked into. POSIX shells only; Windows (`cmd`, PowerShell) syntax isn't parsed.

## Built-in: browserpaw

Runs isolated Chromium profiles with the [BrowserPaw](https://github.com/clarkehackworth/browserpaw) extension on SSH hosts. Admins configure:

- **Browser hosts**: an SSH host from the ssh plugin (with a pinned key), the BrowserPaw checkout and extension dir there, the Chromium binary, the profiles directory and the launch environment (`DISPLAY=:0`). Use **Check host** to verify.
- **Profiles**: each one is its own `--user-data-dir` with its own logins and its own BrowserPaw bridge. **Set up & start** creates the directory, a per-profile `NativeMessagingHosts/` manifest (allowing only the extension's id), and a host wrapper that sets the tool profile. It then launches Chromium with `--load-extension` and caches the tool list.

When an agent calls a tool, the plugin finds the profile's bridge: it is the listening process whose ancestor is that profile's Chromium, found with `ps` and `ss`. The plugin tunnels to the bridge with ssh `forwardOut` and forwards the call with the bridge's bearer token. If the profile isn't running, it starts it first (when "Start on demand" is on). Each profile can set a **Proxy server** (Chromium `--proxy-server`, e.g. `socks5://host:1080`) and a **bypass list**. It applies when the browser starts, so stop and restart the profile after changing it. Proxy credentials aren't supported. Agents get the BrowserPaw tools plus `profiles`. When more than one profile is exposed, every tool requires a `profile` argument. Agents never see SSH, ports or the token. Hide risky tools with the instance's expose/hide lists, or set them to ask or deny in the server's Tool rules (`chrome_javascript`, cookies, network capture).

The SSH user needs a normal shell, because the plugin runs setup commands as that user. Don't reuse a `command="true"` tunnel-only key for this host.

### Native host (this machine)

Tick **Native (this machine)** to run the browser where MControlProgram itself runs. The same setup, clone/build, launch and status commands run locally instead of over ssh, and the bridge is reached on `127.0.0.1`. **Set up & start** and start on demand work as for ssh hosts. If MControlProgram is in a container, git, node, the browser and a display (`DISPLAY`, via **Launch environment**) must exist inside that container; for a browser on the Docker host use a manual host instead.

### Manual hosts (no ssh)

For a browser on a machine MControlProgram can't ssh to (typically the Docker host itself), tick **Manual (no ssh)** on the host and set:

- **Operating system** (`macos` or `linux`) and **Home directory** (e.g. `/Users/you`), so the generated commands use absolute paths.
- **Bridge address**: where MControlProgram reaches the bridge. Empty = `host.docker.internal`, which Docker Desktop forwards to the host's loopback. The bridge only listens on `127.0.0.1` there and rejects any other `Host` header, so the plugin sends `Host: 127.0.0.1:<port>` itself.
- **Bridge token**: `cat ~/.chrome-mcp/bridge-token` on that machine (the file exists after the browser has started once).

Nothing runs automatically. **Set up & start** on a profile shows steps and a shell script to paste into a terminal on that machine: it clones and builds BrowserPaw if needed, writes the profile's native messaging manifest and launches the browser. After that the plugin finds the bridge by probing ports 12306-12316 (pin one with the profile's **Bridge port** if several profiles run on the host). Stopping is done by closing the browser; "Start on demand" can't launch it, so agents get an error when it isn't running.

**Operating systems.** Each browser host has an **Operating system** setting (`auto`, `linux`, `macos`, `windows`) and a **Browser** setting (`chromium`, `chrome`, `edge`). With `auto`, the plugin runs `uname -s` and falls back to a PowerShell probe; **Check host** shows the result and re-detects. Empty binary, profiles-directory and environment fields use per-OS defaults. The per-OS command sets live in `src/plugins/browserpaw/platform.ts`:

| | Linux | macOS | Windows |
|---|---|---|---|
| Remote shell | `sh -c` | `sh -c` | PowerShell (`-EncodedCommand`) |
| Native messaging | `<profile>/NativeMessagingHosts/` manifest + wrapper | same as Linux | `HKCU\Software\<browser>\NativeMessagingHosts`, one per user, origins merged |
| Tool profile | set in the wrapper | set in the wrapper | set in the browser's environment |
| Launch | `setsid -f` (else `nohup`), `DISPLAY` from env | `open -n -a <App>.app` | scheduled task on the logged-in desktop |
| Bridge port | `ss` | `lsof` | `Get-NetTCPConnection` |

Windows requirements: OpenSSH Server, the SSH user logged in to a desktop session, and BrowserPaw's `run_host.bat`. Because the HKCU registration is shared, setting up a profile replaces any registration BrowserPaw's own installer made, keeping its allowed origins. Branded Chrome and Edge 137+ ignore `--load-extension` by default, so the plugin adds `--disable-features=DisableLoadExtensionCommandLineSwitch` for them. Linux is tested against a real host. The macOS and Windows commands are covered by unit tests only (macOS shares the POSIX scripts, which the tests run under `sh`).

### URL access policy and request log

The BrowserPaw page has **Access rules** and a **Request log**, like the Web plugin's, but with a separate list. One list (block and allow rules by domain, URL or regex; allow or deny by default) applies to every profile and to everything the browser loads: pages, frames, scripts, fetch/XHR and websockets. It is pushed to running browsers immediately and enforced inside the extension. **Fail closed**: a browser that hasn't confirmed the current list gets no tool calls and blocks all traffic. Non-web schemes (`file:`, `chrome:`, `ftp:`, `ssh:`…) are always refused. Patterns use the browser's regex engine (no lookahead or backreferences). Agents can read the list with the `policy` tool.

Every event is logged with the profile, tab and calling agent (token or OAuth client), whether it was allowed and by which rule, and where it was blocked (before reaching the browser or inside it). The log filters by time, outcome, profile, source and text, and each row has **Block domain** / **Block URL** shortcuts. Design notes: [browserpaw-url-policy.md](browserpaw-url-policy.md).

The hosts table shows a **Type** column (Native / Manual / SSH) and hides the fields that only apply to manual hosts.

## Raw JSON Schema tools

A tool may give `jsonSchema` (a JSON Schema object) instead of a zod `inputSchema`. MControlProgram
forwards it to agents verbatim and does not validate arguments; use this when you are proxying
tools whose schema you receive at runtime (see `src/plugins/mcp`).

## Approval gating

**Whole tools.** Each instance has tool rules (allow / ask / deny per tool, plus a default) applied by
the gateway. A plugin controls only `annotations.readOnlyHint`: set it on tools that cannot change
anything, so "ask for tools that are not read-only" asks about the right ones. A handler is not invoked
until its ask is approved, and never for a denied tool.

**What a call does.** When your plugin has its own rules (commands, URLs, …), give them an `ask` action
next to allow/block and ask from the handler:

```js
if (!call.ask) throw new Error('needs approval'); // no approval channel (tests, admin actions): fail closed
const approvedBy = await call.ask({
  feature: 'command',             // groups asks on your plugin page
  summary: `${host}: ${command}`, // one line for the admin
  reason: 'program: systemctl',   // the rule that asked, or 'default: ask'
  subject: { host, command },     // identity: same subject = same request (a check-back)
});
```

It resolves with `"approved by <admin>"` (log it). If the call may not run yet, it throws an
`ApprovalError` whose message tells the agent to check back, pause, or stop; let it propagate as the
tool error. Built-in plugins use the `ask(call, spec)` helper from `src/core/plugin-api.ts`, which does
the fail-closed check. Ask
last, after your other checks, so nobody approves something that would be refused anyway. Pending asks
appear on the Approvals page and, filtered with `GET /api/approvals?plugin=<id>`, on your plugin page.

## Built-in: sandbox (Docker Sandboxes)

Drives the [`sbx`](https://docs.docker.com/reference/cli/sbx/) CLI on SSH hosts (depends on `ssh@^0.2.0`; tested against sbx v0.49.2). **Sandbox hosts** name an SSH host where `sbx` is installed and logged in; **Check host** runs `sbx version`. Each instance exposes a selection of hosts.

Tools: `hosts`, `list`, `create` (agent kit, workspace mounts, ports, cpus/memory, initial deny rules), `stop`, `remove`, `exec` (`sh -c`, no TTY), `read_file`, `write_file` (≤ 90 KB, sent base64 over the ssh command line), `copy` (`sbx cp` between the host and a sandbox), `ports`, `policy`, `network_log`, `network_check`, `network_allow`, `network_deny`, `network_remove`. `create` needs the first workspace read/write (sbx refuses a read-only primary). Everything inside a sandbox is fair game; on the **host**, `create` mounts and `copy` paths must sit inside the host's **Workspace roots** (empty = no host file access). That check is lexical, so keep untrusted symlinks out of the roots. The plugin has no rules of its own: gate the mutating tools (`network_allow`, `remove`, `create`, `exec`…) with the server's Tool rules.

### Native hosts

Tick **Native (this machine)** on a sandbox host to run `sbx` where MControlProgram runs, without ssh (no SSH host needed). Agents given that host can drive every sandbox the local sbx user owns.

When MControlProgram runs in a container on the Docker host, mount sbx into it at the **same paths** as on the host, and set the host's **sbx binary** to `env HOME=/home/<user> sbx`:

- `/usr/bin/sbx` (read-only; it is a static binary)
- `~/.local/state/sandboxes` (the sandboxd socket), `~/.sbx`, `~/.config/sandboxes`, `~/.config/com.docker.sandboxes`
- `~/.docker` (read-only; the Docker login)
- every workspace root, also at its host path: `create` hands paths to the daemon (host paths) while `cp` reads and writes them in the container

The container user must match the uid that owns those files (the image runs as 1000). See the commented lines in `docker-compose.yml`. Anyone with access to these mounts controls all of that user's sandboxes.

The plugin page shows, for the host selected in the hosts table (click a row): the sandboxes (status, ports, workspaces; create, start, stop, remove), an expandable row per sandbox (run a command, publish/unpublish ports), the policy in two tabs: Network (add allow/deny rules globally or for the selected sandbox, remove rules, check a host or URL) and Filesystem (read-only: which host paths may be mounted; sbx has no CLI to change them) and the network log (allowed and blocked connections, with **Allow host** on blocked ones). It runs the agent tools through the hidden `call` global action, so it applies the same workspace-root checks but not the server's Tool rules.

## Built-in: git

Lets an agent with a **read-only** clone get changes committed, pushed and turned into PRs. It works with any git server. PRs need a **PR provider** on the git host: GitHub, GitLab or Gitea / Forgejo.

This plugin used to be called `github`. On startup MControlProgram moves the old plugin's config, server pairings, pending approvals and tables to `git`. A default instance named `github` becomes `git`, so agents' tools are renamed from `github_…` to `git_…`.

 MControlProgram does the git work in clones on a **git host**: an SSH host from the ssh plugin (depends on `ssh@^0.2.2`: `exec` with stdin, streaming `spawn`) or this machine (**Native**). The push credential stays on that host: an ssh key that **Set up host** generates there (`~/.ssh/mcontrolprogram_git` by default). Agents never see it. Repo hooks never run (`core.hooksPath=/dev/null`). Pushes use `GIT_SSH_COMMAND` with that key, `IdentitiesOnly` and `StrictHostKeyChecking=accept-new`.

**Git hosts:**

- **Repos directory**: every clone directly under it is a repo.
- **SSH key**
- **Committer identity**
- **PR provider**: `none` (git only, the default), `github`, `gitlab` or `gitea` (also Forgejo). Hosts saved before the rename that have a token count as `github`.
  - `gh` is GitHub through the `gh` CLI on the git host. It uses the host's own `gh auth login` (scope `repo`), so MControlProgram holds no token. The calls are the `github` provider's, made with `gh api`; `--hostname` follows the origin or API URL, for Enterprise. `gh` must be installed and logged in as the user that runs git there. **Set up host** reports `gh auth status`. The trade-off: that login is a credential on the host, usable by anything else running as that user.
- **API token**: optional, kept by MControlProgram and used only for the provider's REST API (PRs, checks, comments). It's never sent to the host.
- **API URL**: empty means it's worked out from the origin's host:
  - GitHub: `api.github.com`, or `https://host/api/v3` for Enterprise
  - GitLab: `https://host/api/v4`
  - Gitea / Forgejo: `https://host/api/v1`

`create_pr`, `pr` and `comment` give the same result shapes on every provider, and only appear when an exposed repo's host has a provider. Differences:
- **GitLab**: `number` is the merge request's iid. Checks are its pipelines and reviews are its approvals. Comments go on merge requests only.
- **Gitea / Forgejo**: checks come from commit statuses. Drafts are opened with a `WIP:` title.
- **GitHub** (`github` and `gh`): `edit_pr {draft}` flips draft / ready for review through GraphQL (REST can't), so the token or `gh` login needs the same access it uses for PRs. GraphQL is `api.github.com/graphql`, or `https://host/api/graphql` for Enterprise.

`create_pr` also takes `labels`, `assignees` and `reviewers`, added to a PR it opens (an already-open PR is returned unchanged). They need the `edit_pr` approval as well as `create_pr`'s. If they fail after the PR is open, the PR comes back with a `warning`. `pr` lists the latest 50 PRs in a state; `search` keeps those whose title, branch or author contains every word (e.g. a ticket id).

**Set up host** checks for git, creates the repos directory and the key, and returns the public key and what `ssh -T git@<forge>` answers. The forge is the API URL's host, or github.com / gitlab.com for those providers; with no provider the key isn't checked. Add the key to the git server as a deploy key with write access (one repo) or to a machine user, then run it again. A native host inside the container should keep the repos directory and key on the data volume (`/data/git/...`).

**Repos** are discovered:

- **When they're scanned:** whenever the plugin page opens, on **Rescan**, and after **Set up host** or **Clone repo…** (`git clone` into the repos directory with the host's key).
- **New clones** are added, named after their directory, or `<host>-<dir>` when that name is taken.
- **Clones gone from a reachable host** are dropped.
- **Settings you edited** are kept: agent branch prefix (default `agent/`), base branches (PR targets, never pushed to), sensitive paths (default `.github/`, `CODEOWNERS`), max patch size, and the **Assisted-by trailer** name (default `Assisted-by`; empty = no trailer).

Pair repos with servers like any inventory.

Each patch is applied in a throwaway worktree under `.git/mcontrolprogram-work/`, so `submit_patch` and `git push mcp` never touch the clone's own checkout. Only the `git`, `write_file` and `push` tools (below) work in it.

Agent workflow:

1. `resolve {ref}`: fetch, then give the sha to `git fetch && git checkout <sha>` (no `ref`: list branches and tags). Refs are resolved as remote branches, then tags, then a sha the remote has.
2. Commit locally and send `submit_patch {base, patch, branch}`. `patch` is either:
   - `git format-patch --stdout <base>` output. It's applied with `git am --3way`, which keeps the agent's commits and messages, then each commit is re-signed: author and committer become the host's identity, and the trailer is added.
   - A plain `git diff` plus `message`: one commit by the host's identity, with `Submitted-by: <agent>` and the trailer.

   Every commit gets `<trailer>: <assisted_by>`, e.g. `Assisted-by: Claude Code (claude-opus-5-5)`. `assisted_by` is one line of at most 100 characters with no `<` or `>`. It defaults to the MCP client name and version the agent connected with (`ToolCallContext.client`), and a duplicate trailer isn't added. Optional `committer_name` + `committer_email` replace the host's identity, as author and committer, for that call. The push uses `--force-with-lease`. Rewriting a branch needs `force: true`. A base that isn't on the remote, or a patch that doesn't apply, returns an error that tells the agent to rebase.
3. `create_pr` (returns the open PR if there is one), `pr` (list, or one PR with checks, reviews and comments) and `comment`.

**MControlProgram as a git remote.** Agents that can reach the MCP server's port can skip patches:

- **`clone_url`** gives `<server>/plugins/<prefix>/git/<repo>.git` and a per-agent token. The token is valid for 24 hours, stored hashed, and tied to the agent's principal and to this instance's repos. It also returns ready-made commands: `git remote add mcp …` plus `git config http.<url>.extraHeader "Authorization: Bearer …"` (the header is scoped to that URL, so it never goes to GitHub), a `clone`, and `refresh`. A missing or expired token gets a 403 telling the agent to call `clone_url` again (Basic auth with the token as password works too).
- **Fetching** gives exactly what MControlProgram has, so `git log mcp/main..HEAD` and `git diff mcp/main` show the agent's changes. The setup commands also set the clone's `user.name`/`user.email` to the host's identity, and suggest `git commit --trailer "Assisted-by: …"`.
  - It's served from a bare mirror, `.git/mcontrolprogram-serve.git`, created on first use. The mirror holds origin's branches (from the clone's `refs/remotes/origin/*`), the clone's tags, and agent pushes. Branches, stashes and commits that exist only in the host clone are never served.
  - Every fetch fetches origin first.
  - Only protocol v0 is served: v2 lets a client fetch any object by sha.
- **`git push mcp HEAD:<prefix><name>`**: receive-pack stores the push in the mirror, then each ref is checked like `submit_patch` and pushed to origin with `--force-with-lease`.
  - The checks are: the `git_push` rule, plus `force_push` if it isn't a fast-forward and `sensitive_paths` for the files changed since the merge-base with the default branch.
  - The commits go through unchanged: git can't rewrite them without the agent's `ok` lying about the sha. Commits whose author or committer isn't the host's identity add `custom_identity` to the checks. The trailer is up to the agent.
  - Only agent branches are accepted. Tags, deletes and base branches are refused, with a message naming the right ref.
  - Refused, failed or pending refs show as `! [remote rejected]` with the reason, and the mirror goes back to origin's value. While an ask is pending, re-running the same push checks back.
  - Pushes over the repo's max patch size get a 413. Objects are fsck'ed. Hooks never run.

**Working in the host clone.** Agents without a clone of their own (or that shouldn't fetch from the git server) can do the git work in MControlProgram's clone:

- **`git {command, args}`** runs one git subcommand there and returns its output and exit code. A conflict doesn't throw: it exits non-zero and lists the files.
  - Read-only, under the `workdir_read` rule: `status`, `log`, `diff`, `show`, `ls-files`, `rev-parse`, `merge-base`, `describe`, `shortlog`.
  - Changing, under `workdir`: `pull`, `fetch`, `switch`, `checkout`, `restore`, `branch`, `stash`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `add`, `rm`, `mv`, `commit`, `clean`.
  - No `push` (see below), `config`, `remote`, `submodule` or `am`. Options that run commands or read or write outside the clone are refused, under any abbreviation: `--exec`, `--upload-pack`, `--receive-pack`, `--output`, `--no-index`, `--pathspec-from-file`, `--file`, `--template`, `--contents`, `--recurse-submodules`, `--ignore-revs-file`, plus `-F`/`-t` on commit, `-F` on merge, `-x` on rebase. `pull` and `fetch` take only `origin` as remote. Give option values as `--opt=value`, messages as `--message=` (`-mFix` reads as `-F`).
  - Editors and pagers are off (`commit --no-edit` takes the merge message), hooks never run, and commits are by the host's identity. Output is capped at 100 KB.
- **`write_file {path, content}`** writes a file and stages it, which resolves a conflict. It goes through the index (`hash-object` + `update-index` + `checkout-index`), so git refuses paths in `.git` and replaces symlinks on the way: nothing lands outside the clone. Rule `workdir`; content up to the max patch size.
- **`push {branch, source?, force?}`** pushes `source` (default `HEAD`) to an agent branch, or to a base branch by its exact name. Checks: `push`, plus `base_push`, `force_push`, `custom_identity` and `sensitive_paths` as for `git push mcp`. Base branches are never rewritten; rewriting an agent branch needs `force: true`. Pushing what the branch already has returns `unchanged`.

A conflict, start to finish: `git pull --no-rebase origin main` → exit 1, `CONFLICT … README.md`; `git show :1:README.md` / `:2:` / `:3:` for base, ours and theirs; `write_file README.md`; `git commit --no-edit` (or `rebase --continue`, `cherry-pick --continue`; `merge --abort` to give up); `push {branch: "fix"}`.

The clone is shared by every agent with the repo: calls run one at a time per repo, but nothing stops two agents switching branches under each other. Its local branches, stashes and commits are never served by the mirror.

**Access rules.** The plugin page has the same per-tool panel as the MCP pass-through, grouped by repo, with its own tables and a call log. A new install starts at *allow read-only, ask the rest*. The rules cover the tools (`clone_url` also covers fetching over HTTP), `git_push`, `push`, `workdir_read` / `workdir` (the host clone tools), and three git features: `force_push` (a submit that isn't a fast-forward), `custom_identity` (a submit with the agent's own name and email, or pushed commits by anyone but the host's identity) and `sensitive_paths` (a submit touching the repo's sensitive paths; CI workflows can read repository secrets). A call checks every feature it touches. Any deny refuses the call, and any ask produces **one** ask for the whole call, since an approval is used by a single execution. Enable/Disable on that ask sets the rule for each of those features. The server's own Tool rules still apply on top.
