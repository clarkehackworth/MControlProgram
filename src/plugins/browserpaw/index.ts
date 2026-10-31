/**
 * BrowserPaw plugin: runs isolated Chromium/Chrome/Edge profiles with the BrowserPaw extension on SSH
 * hosts (Linux, macOS or Windows) and re-exposes their browser tools to agents.
 *
 * Per profile, on the remote host (all over the ssh plugin, which must have the host pinned):
 *   - a --user-data-dir of its own (cookies, logins);
 *   - a native messaging registration admitting only the BrowserPaw extension id (per profile on
 *     Linux/macOS, per user in HKCU on Windows; see platform.ts);
 *   - the browser launched with --load-extension. The extension starts BrowserPaw's bridge, which binds a
 *     free port in 127.0.0.1:12306-12316, authenticated by the user's ~/.chrome-mcp/bridge-token.
 * MControlProgram finds the listening bridge whose process descends from the profile's browser, tunnels to
 * it with ssh `forwardOut`, and talks MCP over the tunnel. Agents never see SSH, ports or the bridge token.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MControlProgramPlugin, PluginContext, PluginInstance, PluginActionContext, ToolDefinition, ToolResult } from '../../core/plugin-api.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { setting } from '../../core/db.js';
import type { SshApi } from '../ssh/index.js';
import { platforms, kv, parseStatus, osFromUname, PROBE_UNIX, PROBE_WINDOWS, type Os, type Browser, type Platform, type Resolved, type Status } from './platform.js';
export { parseStatus, sp } from './platform.js';

interface HostCfg { name: string; sshHost: string; os?: Os | 'auto'; browser?: Browser; description?: string; browserpawDir?: string; extensionDir?: string; chromium?: string; profilesDir?: string; env?: string }
interface ProfileCfg { name: string; host: string; description?: string; toolProfile?: 'core' | 'full' | 'crawl'; headless?: boolean; autoStart?: boolean; extraArgs?: string }
interface GlobalCfg { hosts: HostCfg[]; profiles: ProfileCfg[]; startTimeoutSec: number; callTimeoutMs: number }
interface Cfg { profiles: string[]; profilesDisabled?: string[]; allowTools: string[]; denyTools: string[]; idleDisconnectSec: number }
type Log = PluginContext['log'];
interface CachedTool { name: string; title?: string; description?: string; inputSchema?: Record<string, any>; annotations?: ToolDefinition['annotations'] }

const NAME = /^[a-zA-Z0-9_-]+$/;

// ---------- host OS ----------

/** Detected OS per ssh host, for hosts configured as `auto`. Cleared by "Check host". */
const detected = new Map<string, Os>();
async function platformOf(ssh: SshApi, h: HostCfg, log: Log): Promise<Platform> {
  if (h.os && h.os !== 'auto') return platforms[h.os];
  let os = detected.get(h.sshHost);
  if (!os) {
    os = osFromUname((await ssh.exec(h.sshHost, PROBE_UNIX, log).catch(() => ({ stdout: '' }))).stdout);
    if (!os && (await ssh.exec(h.sshHost, PROBE_WINDOWS, log).catch(() => ({ stdout: '' }))).stdout.includes('windows')) os = 'windows';
    if (!os) throw new Error(`host ${h.name}: could not detect the OS over ssh (uname and PowerShell both failed); set it on the host`);
    detected.set(h.sshHost, os);
    log.info(`browserpaw: host ${h.name} detected as ${os}`);
  }
  return platforms[os];
}

/** Run a platform script; output normalized to \n line endings. */
async function run(ssh: SshApi, h: HostCfg, pf: Platform, script: string, log: Log) {
  const r = await ssh.exec(h.sshHost, pf.wrap(script), log);
  return { ...r, stdout: r.stdout.replace(/\r/g, '') };
}

const paths = (h: HostCfg, pf: Platform, p?: ProfileCfg) => {
  const d = pf.defaults(h.browser ?? 'chromium');
  const bp = (h.browserpawDir || '~/dev/browserpaw').replace(/[\\/]+$/, '');
  return {
    ext: h.extensionDir || `${bp}/app/chrome-extension/.output/chrome-mv3`,
    nativeHost: `${bp}/${pf.nativeHostRel}`,
    chromium: h.chromium || d.chromium,
    profile: p ? `${(h.profilesDir || d.profilesDir).replace(/[\\/]+$/, '')}/${p.name}` : undefined,
  };
};

function launchEnv(h: HostCfg, pf: Platform): [string, string][] {
  const lines = (h.env ?? pf.defaults(h.browser ?? 'chromium').env).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => {
    const i = l.indexOf('='); const k = l.slice(0, i);
    if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`host ${h.name}: bad env line "${l}"`);
    return [k, l.slice(i + 1)];
  });
}

/** Resolve paths on the host (creating the profile dir if given) and report what is installed. */
async function inspect(ssh: SshApi, h: HostCfg, log: Log, p?: ProfileCfg) {
  const pf = await platformOf(ssh, h, log);
  const x = paths(h, pf, p);
  const o = kv((await run(ssh, h, pf, pf.inspect(x), log)).stdout);
  let key: string | undefined;
  try { key = o.manifest ? JSON.parse(Buffer.from(o.manifest, 'base64').toString().replace(/^\uFEFF/, '')).key : undefined; } catch { /* id from path */ }
  return { pf, ext: o.ext || undefined, extensionId: o.ext ? pf.extensionId(o.ext, key) : undefined, nativeHost: o.nativehost || undefined, chromium: o.chromium || undefined, dir: o.dir || undefined, paths: x };
}

/** Create the profile dir and its native messaging registration. Idempotent. */
async function setupProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log) {
  const i = await inspect(ssh, h, log, p);
  const missing = [!i.ext && `extension dir ${i.paths.ext}`, !i.nativeHost && `native host ${i.paths.nativeHost}`, !i.chromium && `browser binary "${i.paths.chromium}"`].filter(Boolean);
  if (missing.length) throw new Error(`host ${h.name} (${i.pf.os}) is missing: ${missing.join(', ')}. Build/install BrowserPaw there (see its INSTALL.md) or fix the host paths.`);
  if (!i.dir) throw new Error(`could not create profile dir ${i.paths.profile}`);
  const r = i as typeof i & Resolved;
  const out = kv((await run(ssh, h, i.pf, i.pf.setup(r, p.name, h.browser ?? 'chromium', p.toolProfile || 'full'), log)).stdout);
  if (out.done !== '1') throw new Error(`profile setup failed on ${h.name} (${i.pf.os})`);
  if (out.previous && !out.previous.startsWith(r.dir.replace(/[\\/][^\\/]+$/, ''))) log.warn(`browserpaw: replaced native messaging registration ${out.previous} on ${h.name} (its allowed origins were kept)`);
  return r;
}

async function status(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log): Promise<Status> {
  const pf = await platformOf(ssh, h, log);
  return parseStatus((await run(ssh, h, pf, pf.status(paths(h, pf, p).profile!), log)).stdout);
}

/** Set up the profile and launch Chromium if it is not running; wait for its bridge. */
async function startProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, timeoutSec: number, log: Log) {
  let st = await status(ssh, h, p, log);
  if (st.bridge) return st;
  const pf = await platformOf(ssh, h, log);
  if (!st.chromiumPid) {
    const r = await setupProfile(ssh, h, p, log);
    await run(ssh, h, pf, pf.launch(r, { browser: h.browser ?? 'chromium', toolProfile: p.toolProfile || 'full', headless: !!p.headless, extraArgs: p.extraArgs ?? '', env: launchEnv(h, pf), task: `MControlProgram-BrowserPaw-${p.name}` }), log);
    log.info(`browserpaw: launched ${h.browser ?? 'chromium'} for profile ${p.name} on ${h.name} (${pf.os})`);
  }
  for (const until = Date.now() + timeoutSec * 1000; Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await status(ssh, h, p, log);
    if (st.bridge) return st;
  }
  const hint = pf.os === 'windows' ? 'Windows needs the user logged in to a desktop session (the browser starts there via a scheduled task)' : `see ${paths(h, pf, p).profile}/chromium.log on ${h.name}`;
  throw new Error(`profile ${p.name}: ${st.chromiumPid ? 'the browser is running but the BrowserPaw bridge did not come up' : 'the browser did not start'} within ${timeoutSec}s (${hint})`);
}

// ---------- MCP over the tunnel ----------

async function connectBridge(ssh: SshApi, h: HostCfg, bridge: NonNullable<Status['bridge']>, log: Log) {
  const t = await ssh.openTunnel(h.sshHost, '127.0.0.1', bridge.port, log);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } });
    const client = new Client({ name: 'mcontrolprogram', version: '0.1.0' });
    await client.connect(transport);
    const onclose = transport.onclose; // the tunnel lives exactly as long as the transport
    transport.onclose = () => { t.close(); onclose?.(); };
    return client;
  } catch (e) { t.close(); throw e; }
}

/** Tool schemas last seen per profile, so tools are listed without waking a browser. */
const toolsKey = (profile: string) => `browserpaw.tools.${profile}`;
const cachedTools = (profile: string): CachedTool[] => JSON.parse(setting.get(toolsKey(profile)) ?? '[]');
async function refreshToolCache(client: Client, profile: string) {
  const list: CachedTool[] = (await client.listTools()).tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as Record<string, any>, annotations: t.annotations as CachedTool['annotations'] }));
  const json = JSON.stringify(list);
  const changed = json !== (setting.get(toolsKey(profile)) ?? '[]');
  if (changed) setting.set(toolsKey(profile), json);
  return changed;
}

// ---------- config ----------

const hostSchema = {
  type: 'object',
  required: ['name', 'sshHost'],
  properties: {
    name: { type: 'string', title: 'Name', pattern: NAME.source, 'x-pattern-hint': 'letters, digits, _ and -' },
    sshHost: { type: 'string', title: 'SSH host', description: 'Host from the SSH plugin inventory (must have a pinned host key). MControlProgram runs setup commands as that user.', 'x-options-from': 'ssh:hosts' },
    os: { type: 'string', title: 'Operating system', enum: ['auto', 'linux', 'macos', 'windows'], default: 'auto', description: 'auto: detected over ssh (uname, else PowerShell). Windows needs OpenSSH Server and PowerShell; macOS and Linux need sh.' },
    browser: { type: 'string', title: 'Browser', enum: ['chromium', 'chrome', 'edge'], default: 'chromium', description: 'Picks the default binary path and, on Windows, the registry key for native messaging. Branded Chrome/Edge get --disable-features=DisableLoadExtensionCommandLineSwitch so --load-extension still works.' },
    description: { type: 'string', title: 'Description' },
    browserpawDir: { type: 'string', title: 'BrowserPaw checkout', description: 'Built BrowserPaw repo on the host (pnpm build). Native host: <dir>/app/native-server/dist/run_host.sh (run_host.bat on Windows). ~/ means the ssh user\'s home on every OS.', default: '~/dev/browserpaw' },
    extensionDir: { type: 'string', title: 'Extension dir', description: 'Unpacked extension (chrome-mv3). Default: <checkout>/app/chrome-extension/.output/chrome-mv3' },
    chromium: { type: 'string', title: 'Browser binary', description: 'Empty = per OS/browser default. Linux: chromium, google-chrome, microsoft-edge (on PATH). macOS: /Applications/<App>.app/Contents/MacOS/<App>. Windows: ~/AppData/Local/Chromium/Application/chrome.exe, C:/Program Files/Google/Chrome/Application/chrome.exe, C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
    profilesDir: { type: 'string', title: 'Profiles directory', description: 'Empty = ~/.local/share/mcontrolprogram-browserpaw (Linux), ~/Library/Application Support/mcontrolprogram-browserpaw (macOS), ~/AppData/Local/mcontrolprogram-browserpaw (Windows)' },
    env: { type: 'string', title: 'Launch environment', description: 'KEY=VALUE per line for the browser. Empty = DISPLAY=:0 on Linux, nothing on macOS/Windows. Add XAUTHORITY=… or WAYLAND_DISPLAY=… as needed on Linux.', format: 'multiline' },
  },
};
const profileSchema = {
  type: 'object',
  required: ['name', 'host'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'Also the directory name under the host\'s profiles directory', pattern: NAME.source, 'x-pattern-hint': 'letters, digits, _ and -' },
    host: { type: 'string', title: 'Host', 'x-options-from': 'hosts' },
    description: { type: 'string', title: 'Description', description: 'Shown to agents (e.g. which accounts are signed in)' },
    toolProfile: { type: 'string', title: 'BrowserPaw tool profile', enum: ['core', 'full', 'crawl'], default: 'full' },
    headless: { type: 'boolean', title: 'Headless', description: 'No window (human handoff for 2FA/captchas will not be possible)', default: false },
    autoStart: { type: 'boolean', title: 'Start on demand', description: 'Launch Chromium when an agent calls a tool and the profile is not running', default: true },
    extraArgs: { type: 'string', title: 'Extra Chromium arguments', description: 'Appended verbatim to the command line' },
  },
};

function lookup(g: GlobalCfg, profile: string) {
  const p = g.profiles.find((x) => x.name === profile);
  if (!p) throw new Error(`unknown profile "${profile}"`);
  if (!NAME.test(p.name)) throw new Error(`profile name "${p.name}" may only contain letters, digits, _ and -`);
  const h = g.hosts.find((x) => x.name === p.host);
  if (!h) throw new Error(`profile ${p.name}: host "${p.host}" is not configured`);
  return { p, h };
}

const plugin: MControlProgramPlugin = {
  id: 'browserpaw',
  name: 'BrowserPaw',
  version: '0.2.0',
  description: 'Run isolated Chromium profiles with the BrowserPaw extension on SSH hosts and give agents their browser tools. MControlProgram sets up the profiles, launches Chromium and tunnels to the bridge; agents never get SSH access or the bridge token.',
  dependencies: { ssh: '^0.2.0' },
  globalConfigSchema: {
    type: 'object',
    properties: {
      hosts: { type: 'array', title: 'Browser hosts', items: hostSchema, default: [], 'x-referenced-by': { inventory: 'profiles', field: 'host', title: 'Profiles' } },
      profiles: { type: 'array', title: 'Profiles', description: 'Each profile is its own Chromium user-data-dir (cookies, logins) with its own BrowserPaw bridge.', items: profileSchema, default: [] },
      startTimeoutSec: { type: 'integer', title: 'Start timeout (seconds)', default: 45 },
      callTimeoutMs: { type: 'integer', title: 'Tool call timeout (ms)', default: 120000 },
    },
  },
  defaultGlobalConfig: { hosts: [], profiles: [], startTimeoutSec: 45, callTimeoutMs: 120000 },
  globalActions: {
    check_host: {
      title: 'Check host', inventory: 'hosts',
      async run({ name }, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === name); if (!h) throw new Error('unknown host');
        detected.delete(h.sshHost); // re-detect
        const i = await inspect(a.dep<SshApi>('ssh'), h, a.log);
        return { ok: !!(i.ext && i.nativeHost && i.chromium), os: i.pf.os + (h.os && h.os !== 'auto' ? ' (configured)' : ' (detected)'), extension: i.ext ?? `MISSING: ${i.paths.ext}`, extensionId: i.extensionId, nativeHost: i.nativeHost ?? `MISSING: ${i.paths.nativeHost}`, browser: i.chromium ?? `MISSING: ${i.paths.chromium}` };
      },
    },
    start_profile: {
      title: 'Set up & start', inventory: 'profiles',
      async run({ name }, a: PluginActionContext) {
        const g = { ...plugin.defaultGlobalConfig, ...a.config } as GlobalCfg;
        const { p, h } = lookup(g, String(name));
        const ssh = a.dep<SshApi>('ssh');
        const st = await startProfile(ssh, h, p, g.startTimeoutSec, a.log);
        const client = await connectBridge(ssh, h, st.bridge!, a.log);
        try {
          const changed = await refreshToolCache(client, p.name);
          if (changed) await a.setConfig(a.config); // reload instances so agents get the (new) tool list
          return { ok: true, chromiumPid: st.chromiumPid, bridgePort: st.bridge!.port, tools: cachedTools(p.name).length };
        } finally { await client.close(); }
      },
    },
    stop_profile: {
      title: 'Stop', inventory: 'profiles',
      async run({ name }, a: PluginActionContext) {
        const { p, h } = lookup(a.config as GlobalCfg, String(name));
        const ssh = a.dep<SshApi>('ssh');
        const st = await status(ssh, h, p, a.log);
        if (!st.chromiumPid) return { ok: true, running: false };
        const pf = await platformOf(ssh, h, a.log);
        await run(ssh, h, pf, pf.stop(st.chromiumPid), a.log);
        return { ok: true, stopped: st.chromiumPid };
      },
    },
    profile_status: {
      title: 'Status', inventory: 'profiles',
      async run({ name }, a: PluginActionContext) {
        const { p, h } = lookup(a.config as GlobalCfg, String(name));
        const st = await status(a.dep<SshApi>('ssh'), h, p, a.log);
        return { dir: st.dir ?? 'not set up', running: !!st.chromiumPid, chromiumPid: st.chromiumPid, bridgePort: st.bridge?.port, cachedTools: cachedTools(p.name).length };
      },
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      profiles: { type: 'array', title: 'Profiles to expose', description: 'Empty = none.', items: { type: 'string', 'x-options-from': 'profiles' }, 'x-disabled-key': 'profilesDisabled', default: [] },
      profilesDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true, default: [] },
      allowTools: { type: 'array', title: 'Allow only these tools', description: 'BrowserPaw tool names; empty = all', items: { type: 'string' }, default: [] },
      denyTools: { type: 'array', title: 'Deny these tools', description: 'e.g. chrome_javascript, chrome_get_cookies, chrome_network_capture', items: { type: 'string' }, default: [] },
      idleDisconnectSec: { type: 'integer', title: 'Idle disconnect (seconds)', description: 'Close the tunnel after no calls (the browser keeps running). 0 = MControlProgram default', default: 0 },
    },
  },
  defaultConfig: { profiles: [], allowTools: [], denyTools: [], idleDisconnectSec: 0 },

  create(ctx: PluginContext): PluginInstance {
    const cfg = ctx.config as Cfg;
    const g = { ...plugin.defaultGlobalConfig, ...ctx.pluginConfig } as GlobalCfg;
    const ssh = ctx.dep<SshApi>('ssh');
    const active = cfg.profiles.filter((n) => !(cfg.profilesDisabled ?? []).includes(n));
    const selected = g.profiles.filter((p) => active.includes(p.name));
    for (const n of cfg.profiles) if (!g.profiles.some((p) => p.name === n)) ctx.log.warn(`profile "${n}" is not configured on the browserpaw plugin`);
    const names = selected.map((p) => p.name);

    const conns = new Map<string, { client: Client; lastUsed: number }>();
    const connecting = new Map<string, Promise<Client>>();
    let reaper: NodeJS.Timeout | undefined;
    const allowed = (tool: string) => !cfg.denyTools.includes(tool) && (cfg.allowTools.length === 0 || cfg.allowTools.includes(tool));

    const client = (name: string): Promise<Client> => {
      const c = conns.get(name);
      if (c) { c.lastUsed = Date.now(); return Promise.resolve(c.client); }
      let p = connecting.get(name);
      if (!p) {
        p = (async () => {
          const { p: prof, h } = lookup(g, name);
          let st = await status(ssh, h, prof, ctx.log);
          if (!st.bridge) {
            if (prof.autoStart === false) throw new Error(`profile ${name} is not running and "Start on demand" is off; ask an admin to start it`);
            st = await startProfile(ssh, h, prof, g.startTimeoutSec, ctx.log);
          }
          const cl = await connectBridge(ssh, h, st.bridge!, ctx.log);
          cl.onclose = () => { if (conns.get(name)?.client === cl) conns.delete(name); };
          conns.set(name, { client: cl, lastUsed: Date.now() });
          ctx.log.connection(`browserpaw ${name}: connected (bridge port ${st.bridge!.port})`);
          if (await refreshToolCache(cl, name).catch(() => false)) rebuild();
          return cl;
        })().finally(() => connecting.delete(name));
        connecting.set(name, p);
      }
      return p;
    };

    const pick = (profile?: string) => {
      const n = profile ?? (names.length === 1 ? names[0] : undefined);
      if (!n) throw new Error(`profile is required; one of: ${names.join(', ')}`);
      if (!names.includes(n)) throw new Error(`profile "${n}" is not available here; one of: ${names.join(', ')}`);
      return n;
    };

    const withProfile = (schema: Record<string, any> = { type: 'object' }) => ({
      ...schema, type: 'object',
      properties: { profile: { type: 'string', enum: names, description: `Browser profile to act in.${names.length > 1 ? '' : ' Optional.'} Each profile is a separate browser with its own logins; see the profiles tool.` }, ...(schema.properties ?? {}) },
      required: names.length > 1 ? ['profile', ...(schema.required ?? [])] : schema.required,
    });

    const profilesTool: ToolDefinition = {
      name: 'profiles',
      description: 'List the browser profiles available to you, what they are for, and whether each browser is running.',
      annotations: { readOnlyHint: true },
      handler: async () => {
        const rows = await Promise.all(selected.map(async (p) => {
          const { h } = lookup(g, p.name);
          const st = await status(ssh, h, p, ctx.log).catch((e) => ({ error: String((e as Error).message) }) as Status & { error?: string });
          return { profile: p.name, description: p.description, host: h.name, running: !!st.chromiumPid, ready: !!st.bridge, startsOnDemand: p.autoStart !== false, ...('error' in st ? { error: st.error } : {}) };
        }));
        return text(JSON.stringify(rows, null, 2));
      },
    };

    const tools: ToolDefinition[] = [];
    // In place: the runtime holds this array, so sessions opened after a refresh see new tools.
    function rebuild() {
      const byName = new Map<string, CachedTool>();
      for (const n of names) for (const t of cachedTools(n)) if (!byName.has(t.name) && allowed(t.name)) byName.set(t.name, t);
      tools.splice(0, tools.length, profilesTool, ...[...byName.values()].map((t): ToolDefinition => ({
        name: t.name, title: t.title, description: t.description ?? '', jsonSchema: withProfile(t.inputSchema), annotations: t.annotations,
        async handler(args, call) {
          try {
            const { profile, ...rest } = args ?? {};
            const c = await client(pick(profile));
            return (await c.callTool({ name: t.name, arguments: rest }, undefined, { signal: call.signal, timeout: g.callTimeoutMs })) as unknown as ToolResult;
          } catch (e) { return errorResult(e); }
        },
      })));
    }
    rebuild();

    return {
      tools,
      start() {
        // Learn tools from profiles that are already running; never launch browsers at gateway start.
        for (const n of names) if (cachedTools(n).length === 0) {
          const { p, h } = lookup(g, n);
          void status(ssh, h, p, ctx.log).then((st) => (st.bridge ? client(n) : undefined)).catch((e) => ctx.log.warn(`browserpaw ${n}: ${(e as Error).message}`));
        }
        reaper = setInterval(() => {
          const idle = effective(cfg.idleDisconnectSec, ctx.global().connectionIdleSec) * 1000;
          for (const [n, c] of conns) if (Date.now() - c.lastUsed > idle) { conns.delete(n); void c.client.close(); ctx.log.debug(`idle disconnect ${n}`); }
        }, 30_000).unref();
      },
      async stop() {
        clearInterval(reaper);
        for (const c of conns.values()) await c.client.close().catch(() => {});
        conns.clear();
      },
      status: () => ({ profiles: names.map((n) => ({ name: n, connected: conns.has(n), cachedTools: cachedTools(n).length })) }),
    };
  },
};

export default plugin;
