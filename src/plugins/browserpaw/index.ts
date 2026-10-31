/**
 * BrowserPaw plugin: runs isolated Chromium profiles with the BrowserPaw extension on SSH hosts and
 * re-exposes their browser tools to agents.
 *
 * Per profile, on the remote host (all over the ssh plugin, which must have the host pinned):
 *   <profilesDir>/<profile>/                      Chromium --user-data-dir
 *     NativeMessagingHosts/com.chromemcp.nativehost.json   admits only the BrowserPaw extension id
 *     browserpaw-host.sh                          wrapper: sets the tool profile, execs BrowserPaw's run_host.sh
 * Chromium is launched with --load-extension=<extensionDir>. The extension starts BrowserPaw's bridge, which
 * binds a free port in 127.0.0.1:12306-12316, authenticated by the user's ~/.chrome-mcp/bridge-token.
 * MControlProgram finds the listening bridge whose process descends from the profile's Chromium (via ps + ss), tunnels to it with
 * ssh `forwardOut`, and talks MCP over the tunnel. Agents never see SSH, ports or the bridge token.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MControlProgramPlugin, PluginContext, PluginInstance, PluginActionContext, ToolDefinition, ToolResult } from '../../core/plugin-api.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { setting } from '../../core/db.js';
import type { SshApi } from '../ssh/index.js';

interface HostCfg { name: string; sshHost: string; description?: string; browserpawDir?: string; extensionDir?: string; chromium?: string; profilesDir?: string; env?: string }
interface ProfileCfg { name: string; host: string; description?: string; toolProfile?: 'core' | 'full' | 'crawl'; headless?: boolean; autoStart?: boolean; extraArgs?: string }
interface GlobalCfg { hosts: HostCfg[]; profiles: ProfileCfg[]; startTimeoutSec: number; callTimeoutMs: number }
interface Cfg { profiles: string[]; profilesDisabled?: string[]; allowTools: string[]; denyTools: string[]; idleDisconnectSec: number }
type Log = PluginContext['log'];
interface CachedTool { name: string; title?: string; description?: string; inputSchema?: Record<string, any>; annotations?: ToolDefinition['annotations'] }

const NAME = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_PROFILES_DIR = '~/.local/share/mcontrolprogram-browserpaw';

// ---------- remote shell helpers ----------

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell word for a path; a leading `~/` becomes "$HOME"/… so it expands remotely. */
export const sp = (p: string) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${sq(p.slice(2))}` : sq(p));
/** Run under POSIX sh whatever the user's login shell is (zsh would abort on an unmatched glob, fish on everything). */
const run = (ssh: SshApi, host: string, script: string, log: Log) => ssh.exec(host, `sh -c ${sq(script)}`, log);
const kv = (out: string) => Object.fromEntries(out.split('\n').map((l) => /^([a-z]+)=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!]));

/** Chrome's id for an unpacked extension: from the manifest `key` if present, else from its absolute path. */
export function extensionId(absPath: string, manifestKey?: string) {
  const hex = createHash('sha256').update(manifestKey ? Buffer.from(manifestKey, 'base64') : Buffer.from(absPath)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const paths = (h: HostCfg, p?: ProfileCfg) => {
  const bp = h.browserpawDir || '~/dev/browserpaw';
  return {
    ext: h.extensionDir || `${bp}/app/chrome-extension/.output/chrome-mv3`,
    nativeHost: `${bp}/app/native-server/dist/run_host.sh`,
    profile: p ? `${h.profilesDir || DEFAULT_PROFILES_DIR}/${p.name}` : undefined,
  };
};

function launchEnv(h: HostCfg) {
  const lines = (h.env ?? 'DISPLAY=:0').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => {
    const i = l.indexOf('='); const k = l.slice(0, i);
    if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`host ${h.name}: bad env line "${l}"`);
    return `export ${k}=${sq(l.slice(i + 1))};`;
  }).join(' ');
}

/** Resolve paths on the host (creating the profile dir if given) and report what is installed. */
async function inspect(ssh: SshApi, h: HostCfg, log: Log, p?: ProfileCfg) {
  const x = paths(h, p);
  const r = await run(ssh, h.sshHost, [
    `ext=$(realpath -e ${sp(x.ext)} 2>/dev/null) && echo "ext=$ext" && echo "manifest=$(base64 -w0 "$ext/manifest.json" 2>/dev/null)"`,
    `echo "nativehost=$(realpath -e ${sp(x.nativeHost)} 2>/dev/null)"`,
    `echo "chromium=$(command -v ${sq(h.chromium || 'chromium')} 2>/dev/null)"`,
    x.profile ? `mkdir -p ${sp(x.profile)} && echo "dir=$(cd ${sp(x.profile)} && pwd -P)"` : 'true',
  ].join('; '), log);
  const o = kv(r.stdout);
  let key: string | undefined;
  try { key = o.manifest ? JSON.parse(Buffer.from(o.manifest, 'base64').toString()).key : undefined; } catch { /* id from path */ }
  return { ext: o.ext || undefined, extensionId: o.ext ? extensionId(o.ext, key) : undefined, nativeHost: o.nativehost || undefined, chromium: o.chromium || undefined, dir: o.dir || undefined, paths: x };
}

/** Create the profile dir, its native messaging manifest and host wrapper. Idempotent. */
async function setupProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log) {
  const i = await inspect(ssh, h, log, p);
  const missing = [!i.ext && `extension dir ${i.paths.ext}`, !i.nativeHost && `native host ${i.paths.nativeHost}`, !i.chromium && `chromium binary "${h.chromium || 'chromium'}"`].filter(Boolean);
  if (missing.length) throw new Error(`host ${h.name} is missing: ${missing.join(', ')}. Build/install BrowserPaw there (see its INSTALL.md) or fix the host paths.`);
  if (!i.dir) throw new Error(`could not create profile dir ${i.paths.profile}`);
  const wrapper = `#!/bin/sh\n# Generated by MControlProgram (browserpaw plugin) for profile ${p.name}; overwritten on setup.\nexport CHROME_MCP_TOOL_PROFILE=${sq(p.toolProfile || 'full')}\nexec ${sq(i.nativeHost!)} "$@"\n`;
  const manifest = JSON.stringify({ name: 'com.chromemcp.nativehost', description: `BrowserPaw (MControlProgram profile ${p.name})`, path: `${i.dir}/browserpaw-host.sh`, type: 'stdio', allowed_origins: [`chrome-extension://${i.extensionId}/`] }, null, 2);
  const put = (content: string, file: string, mode: string) => `printf %s ${sq(Buffer.from(content).toString('base64'))} | base64 -d > ${sq(file)} && chmod ${mode} ${sq(file)}`;
  const r = await run(ssh, h.sshHost, [`mkdir -p ${sq(i.dir + '/NativeMessagingHosts')}`, put(wrapper, `${i.dir}/browserpaw-host.sh`, '700'), put(manifest, `${i.dir}/NativeMessagingHosts/com.chromemcp.nativehost.json`, '600'), 'echo done'].join(' && '), log);
  if (!r.stdout.includes('done')) throw new Error(`profile setup failed: ${r.stderr || r.stdout}`);
  return i as typeof i & { dir: string; ext: string; extensionId: string; chromium: string };
}

interface Status { dir?: string; chromiumPid?: number; bridge?: { pid: number; port: number; token: string } }

/**
 * Find the profile's Chromium and the BrowserPaw bridge it started. The bridge's port comes from `ss`
 * (the process tree ties it to this profile); BrowserPaw's registry is keyed by extension id, which every
 * profile shares, so it cannot tell profiles apart. The bearer token is per user, shared by all bridges.
 */
export function parseStatus(out: string): Status {
  // markers are written as @@S''S@@ etc. in the command, so `ps` listing our own shell cannot fake them
  const [psOut = '', rest = ''] = out.split('\n@@SS@@\n');
  const [ssOut = '', token = ''] = rest.split('\n@@TOKEN@@\n').map((x) => x.trim());
  const dir = kv(psOut).dir || undefined;
  const procs = new Map<number, { ppid: number; args: string }>();
  for (const l of psOut.split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3]! }); }
  if (!dir) return {};
  const flag = `--user-data-dir=${dir}`;
  const chromiumPid = [...procs].find(([, x]) => !x.args.includes(' --type=') && (x.args.includes(`${flag} `) || x.args.endsWith(flag)))?.[0];
  if (!chromiumPid) return { dir };
  const descends = (pid: number) => { for (let i = 0; i < 20 && pid > 1; i++) { if (pid === chromiumPid) return true; pid = procs.get(pid)?.ppid ?? 0; } return false; };
  if (!/^[0-9a-fA-F]{48,64}$/.test(token)) return { dir, chromiumPid };
  for (const l of ssOut.split('\n')) {
    const m = /\s127\.0\.0\.1:(\d+)\s.*\bpid=(\d+)/.exec(l);
    if (m && descends(Number(m[2]))) return { dir, chromiumPid, bridge: { pid: Number(m[2]), port: Number(m[1]), token } };
  }
  return { dir, chromiumPid };
}

async function status(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log): Promise<Status> {
  const d = sp(paths(h, p).profile!);
  const r = await run(ssh, h.sshHost, `[ -d ${d} ] && echo "dir=$(cd ${d} && pwd -P)"; ps -eo pid=,ppid=,args=; echo @@S''S@@; ss -ltnpH 2>/dev/null; echo @@TOK''EN@@; cat "$HOME"/.chrome-mcp/bridge-token 2>/dev/null; true`, log);
  return parseStatus(r.stdout);
}

/** Set up the profile and launch Chromium if it is not running; wait for its bridge. */
async function startProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, timeoutSec: number, log: Log) {
  let st = await status(ssh, h, p, log);
  if (st.bridge) return st;
  if (!st.chromiumPid) {
    const i = await setupProfile(ssh, h, p, log);
    const args = [`--user-data-dir=${sq(i.dir)}`, `--load-extension=${sq(i.ext)}`, '--no-first-run', '--no-default-browser-check', ...(p.headless ? ['--headless=new'] : []), p.extraArgs ?? ''].join(' ');
    // ponytail: extraArgs is appended verbatim (shell syntax); it is admin-only config like the ssh host itself
    await run(ssh, h.sshHost, `${launchEnv(h)} cd ${sq(i.dir)} && setsid -f ${sq(i.chromium)} ${args} about:blank >> ${sq(i.dir + '/chromium.log')} 2>&1 < /dev/null; echo launched`, log);
    log.info(`browserpaw: launched chromium for profile ${p.name} on ${h.name}`);
  }
  for (const until = Date.now() + timeoutSec * 1000; Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await status(ssh, h, p, log);
    if (st.bridge) return st;
  }
  throw new Error(`profile ${p.name}: ${st.chromiumPid ? 'chromium is running but the BrowserPaw bridge did not come up' : 'chromium did not start'} within ${timeoutSec}s (see ${paths(h, p).profile}/chromium.log on ${h.name})`);
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
    description: { type: 'string', title: 'Description' },
    browserpawDir: { type: 'string', title: 'BrowserPaw checkout', description: 'Built BrowserPaw repo on the host (pnpm build). Native host: <dir>/app/native-server/dist/run_host.sh', default: '~/dev/browserpaw' },
    extensionDir: { type: 'string', title: 'Extension dir', description: 'Unpacked extension (chrome-mv3). Default: <checkout>/app/chrome-extension/.output/chrome-mv3' },
    chromium: { type: 'string', title: 'Chromium binary', default: 'chromium' },
    profilesDir: { type: 'string', title: 'Profiles directory', default: DEFAULT_PROFILES_DIR },
    env: { type: 'string', title: 'Launch environment', description: 'KEY=VALUE per line for Chromium, e.g. DISPLAY=:0 and XAUTHORITY=…', format: 'multiline', default: 'DISPLAY=:0' },
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
  version: '0.1.0',
  description: 'Run isolated Chromium profiles with the BrowserPaw extension on SSH hosts and give agents their browser tools. MControlProgram sets up the profiles, launches Chromium and tunnels to the bridge; agents never get SSH access or the bridge token.',
  dependencies: { ssh: '^0.2.0' },
  globalConfigSchema: {
    type: 'object',
    properties: {
      hosts: { type: 'array', title: 'Browser hosts', items: hostSchema, default: [] },
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
        const i = await inspect(a.dep<SshApi>('ssh'), h, a.log);
        return { ok: !!(i.ext && i.nativeHost && i.chromium), extension: i.ext ?? `MISSING: ${i.paths.ext}`, extensionId: i.extensionId, nativeHost: i.nativeHost ?? `MISSING: ${i.paths.nativeHost}`, chromium: i.chromium ?? `MISSING: ${h.chromium || 'chromium'}` };
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
        await ssh.exec(h.sshHost, `kill ${st.chromiumPid}`, a.log);
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
