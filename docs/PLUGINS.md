# MControlProgram plugin API

A plugin is an ES module whose **default export** implements `MControlProgramPlugin`
(`src/core/plugin-api.ts`). MControlProgram instantiates it once per *plugin instance*
(a plugin added to a specific MCP server with its own config).

```ts
export default {
  id: 'ssh',                 // [a-z][a-z0-9_-]* ; default tool prefix
  name: 'SSH', version: '1.0.0', description: '…',
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

The UI renders generic action buttons for any plugin. A plugin that needs a richer flow ships a
panel in `web/src/plugins/<id>*.tsx` and registers it by plugin id in `web/src/pages/Plugins.tsx`.

## `create(ctx)` → `PluginInstance`

```ts
interface PluginContext { instanceId; instanceName; serverId; config; pluginConfig; global: () => GlobalConfig; log: ScopedLogger }
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
  from `core/global-config` returns the instance override when > 0, else the global. Document the
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

1. Built-ins (`src/plugins/*`).
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
- `ctx.dep(id)` throws for a plugin you did not declare, so dependencies stay explicit.
- The provider exports what it offers as `api` on its plugin object, and bumps `version` when that changes (semver: a breaking change bumps the major version, or the minor version while it is 0.x).
- Built-in providers: `ssh@0.2.0` exposes `SshApi` (`hostNames`, `exec`, `openTunnel`). It only works with hosts that have a pinned host key. Hosts with auth `native` need no pin: they run on the MControlProgram machine itself (exec and shells via the local shell, SFTP via the local filesystem, `openTunnel` returns the port as is). Agents given a native host get this machine's privileges, including MControlProgram's own data, so restrict it with command patterns and an SFTP root. Shells have no pty.
- An inventory field can offer another plugin's inventory as a dropdown with `'x-options-from': '<pluginId>:<key>'`, for example `'ssh:hosts'`.
- The "Used by" column (server toggles + Pair server) appears only on inventories that an instance config selects from (`x-options-from`). An inventory that other inventory items point at by name can say so with `'x-referenced-by': { inventory, field, title }`; its table then lists those items instead (and the delete confirmation warns about them).
- `x-no-column: true` on an inventory field keeps it in the edit form but out of the table.
- A global action with `inventory: '<key>'` only shows as a row button on that inventory table.

## Built-in: ssh command log and rules

The SSH plugin page has **Command rules** and a **Command log**, like the Web plugin's access rules and request log. Every agent `exec`, `shell_send` and `sftp_*` call is logged (host, agent, command or path, exit code, time; never output), pruned after the global log retention.

Rules live in their own tables (`ssh_rules`, `ssh_policy`), apply live to every SSH instance without restarts, and only to agent `exec` / `shell_send` (not to `SshApi` calls from other plugins such as browserpaw). Command lines are parsed with tree-sitter-bash (`src/plugins/ssh/shell-parse.ts`) into every command they run: pipelines, lists, subshells, `if`/`for` bodies, `$( )` and backticks, commands behind wrappers (`sudo`, `env`, `xargs`, `timeout`, `find -exec`…), and the contents of `sh -c "…"`, `su -c`, `eval` and `ssh host "…"`, recursively. Output redirects (`>`, `>>`, `&>`) are collected as written files. Rule kinds: **program** (by basename), **prefix** (a command starting with it, whole words), **regex** (each command; block rules also the whole line) and **write** (redirect target path prefix, whole components; `/dev/null` always allowed), each for all hosts or one. Block rules win. Under deny by default every command and written file needs an allow rule, and lines that can't be fully analysed are refused: a program, `-c` script or output file built from `$VAR`/`$( )`, a shell reading commands from stdin or a script file, syntax errors. The host's own `allowCommands` / `denyCommands` patterns are checked after. It's a guardrail, not a sandbox: interpreters (`python -c`, `perl -e`, `node`…), programs that write files themselves (`cp`, `tee`, `sed -i`) and scripts on disk aren't looked into. POSIX shells only; Windows (`cmd`, PowerShell) syntax isn't parsed.

## Built-in: browserpaw

Runs isolated Chromium profiles with the [BrowserPaw](https://github.com/clarkehackworth/browserpaw) extension on SSH hosts. Admins configure:

- **Browser hosts**: an SSH host from the ssh plugin (with a pinned key), the BrowserPaw checkout and extension dir there, the Chromium binary, the profiles directory and the launch environment (`DISPLAY=:0`). Use **Check host** to verify.
- **Profiles**: each one is its own `--user-data-dir` with its own logins and its own BrowserPaw bridge. **Set up & start** creates the directory, a per-profile `NativeMessagingHosts/` manifest (allowing only the extension's id), and a host wrapper that sets the tool profile. It then launches Chromium with `--load-extension` and caches the tool list.

When an agent calls a tool, the plugin finds the profile's bridge: it is the listening process whose ancestor is that profile's Chromium, found with `ps` and `ss`. The plugin tunnels to the bridge with ssh `forwardOut` and forwards the call with the bridge's bearer token. If the profile isn't running, it starts it first (when "Start on demand" is on). Each profile can set a **Proxy server** (Chromium `--proxy-server`, e.g. `socks5://host:1080`) and a **bypass list**. It applies when the browser starts, so stop and restart the profile after changing it. Proxy credentials aren't supported. Agents get the BrowserPaw tools plus `profiles`. When more than one profile is exposed, every tool requires a `profile` argument. Agents never see SSH, ports or the token. Use the instance's allow/deny lists and approval policy for risky tools (`chrome_javascript`, cookies, network capture).

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

## Raw JSON Schema tools

A tool may give `jsonSchema` (a JSON Schema object) instead of a zod `inputSchema`. MControlProgram
forwards it to agents verbatim and does not validate arguments; use this when you are proxying
tools whose schema you receive at runtime (see `src/plugins/mcp`).

## Approval gating

MControlProgram can require a human to approve a tool call before it runs; this happens in the gateway, not
in your plugin. The only thing a plugin controls is `annotations.readOnlyHint` on each tool: set it on
tools that cannot change anything, so the "tools that are not read-only" policy gates the right ones.
A gated handler is simply not invoked until approved, so there is nothing else to do.
