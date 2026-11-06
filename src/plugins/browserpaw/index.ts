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
import http from 'node:http';
import { exec } from 'node:child_process';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as policy from './policy.js';
import type { BridgeCall } from './policy.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MControlProgramPlugin, PluginContext, PluginInstance, PluginActionContext, ToolDefinition, ToolResult } from '../../core/plugin-api.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { setting } from '../../core/db.js';
import type { SshApi } from '../ssh/index.js';
import { PWNFOX_COLORS, type PwnfoxColor } from './pwnfox.js';
import { HOST_NAME, platforms, kv, parseStatus, osFromUname, PROBE_UNIX, PROBE_WINDOWS, type Os, type Browser, type Platform, type Resolved, type Status } from './platform.js';
export { parseStatus, sp } from './platform.js';
import { sp } from './platform.js';

interface HostCfg { name: string; sshHost: string; os?: Os | 'auto'; browser?: Browser; description?: string; browserpawDir?: string; native?: boolean; manual?: boolean; homeDir?: string; bridgeHost?: string; bridgeToken?: string; repoUrl?: string; extensionDir?: string; chromium?: string; profilesDir?: string; env?: string }
interface ProfileCfg { name: string; host: string; description?: string; bridgePort?: number; toolProfile?: 'core' | 'full' | 'crawl'; headless?: boolean; autoStart?: boolean; proxy?: string; proxyBypass?: string; pwnfoxColor?: PwnfoxColor; extraArgs?: string }
interface GlobalCfg { hosts: HostCfg[]; profiles: ProfileCfg[]; startTimeoutSec: number; callTimeoutMs: number }
interface Cfg { profiles: string[]; profilesDisabled?: string[]; allowTools: string[]; denyTools: string[]; idleDisconnectSec: number }
type Log = PluginContext['log'];
interface CachedTool { name: string; title?: string; description?: string; inputSchema?: Record<string, any>; annotations?: ToolDefinition['annotations'] }

const NAME = /^[a-zA-Z0-9_-]+$/;

// ---------- native hosts: same commands, run on the MControlProgram machine itself ----------

/** Stands in for the ssh plugin: commands run locally and the "tunnel" is the bridge's own loopback port. */
const local: SshApi = {
  hostNames: () => [],
  exec: (_host, cmd) => new Promise((resolve) => exec(cmd, { timeout: 120_000, maxBuffer: 16 << 20 }, (e: any, stdout, stderr) => resolve({ stdout, stderr, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 }))),
  openTunnel: async (_host, _remoteHost, port) => ({ port, close() {} }),
};
const via = (ssh: SshApi, h: HostCfg) => (h.native ? local : ssh);

// ---------- host OS ----------

/** Detected OS per ssh host, for hosts configured as `auto`. Cleared by "Check host". */
const detected = new Map<string, Os>();
async function platformOf(ssh: SshApi, h: HostCfg, log: Log): Promise<Platform> {
  ssh = via(ssh, h);
  if (h.os && h.os !== 'auto') return platforms[h.os];
  if (h.native) return platforms[process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'];
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
  const r = await via(ssh, h).exec(h.sshHost, pf.wrap(script), log);
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

const DEFAULT_REPO = 'https://github.com/clarkehackworth/browserpaw.git';
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Clone (if absent) and build BrowserPaw on a unix host. Needs git, node and pnpm (or corepack) there. */
async function installBrowserpaw(ssh: SshApi, h: HostCfg, pf: Platform, log: Log) {
  if (pf.os === 'windows') throw new Error(`host ${h.name}: automatic BrowserPaw install is not supported on Windows; clone and build it there (see INSTALL.md)`);
  const dir = sp((h.browserpawDir || '~/dev/browserpaw').replace(/[\\/]+$/, ''));
  log.info(`browserpaw: cloning/building BrowserPaw on ${h.name} (this can take several minutes)`);
  const script = [
    'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm"',
    // ssh sessions skip the profile, so pick up nvm if it is there
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1',
    'set -e',
    `[ -d ${dir}/.git ] || { mkdir -p ${dir} && git clone ${q(h.repoUrl || DEFAULT_REPO)} ${dir}; }`,
    `cd ${dir}`,
    'command -v pnpm >/dev/null 2>&1 || corepack enable pnpm',
    'pnpm install && pnpm build',
  ].join('\n');
  const r = await run(ssh, h, pf, script, log);
  if (r.code !== 0) throw new Error(`BrowserPaw clone/build failed on ${h.name} (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n')}`);
}

/** Create the profile dir and its native messaging registration. Idempotent. */
async function setupProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log) {
  let i = await inspect(ssh, h, log, p);
  if (!i.ext || !i.nativeHost) { await installBrowserpaw(ssh, h, i.pf, log); i = await inspect(ssh, h, log, p); }
  const missing = [!i.ext && `extension dir ${i.paths.ext}`, !i.nativeHost && `native host ${i.paths.nativeHost}`, !i.chromium && `browser binary "${i.paths.chromium}"`].filter(Boolean);
  if (missing.length) throw new Error(`host ${h.name} (${i.pf.os}) is missing: ${missing.join(', ')}. The build ran but did not produce them, or the paths are wrong; check the host's BrowserPaw checkout/extension dir.`);
  if (!i.dir) throw new Error(`could not create profile dir ${i.paths.profile}`);
  const r = i as typeof i & Resolved;
  const out = kv((await run(ssh, h, i.pf, i.pf.setup(r, p.name, h.browser ?? 'chromium', p.toolProfile || 'full'), log)).stdout);
  if (out.done !== '1') throw new Error(`profile setup failed on ${h.name} (${i.pf.os})`);
  if (out.previous && !out.previous.startsWith(r.dir.replace(/[\\/][^\\/]+$/, ''))) log.warn(`browserpaw: replaced native messaging registration ${out.previous} on ${h.name} (its allowed origins were kept)`);
  return r;
}

// ---------- manual hosts (no ssh): the user runs the commands, the bridge is reached over plain http ----------

const BRIDGE_PORTS = Array.from({ length: 11 }, (_, k) => 12306 + k);
const bridgeAddr = (h: HostCfg, port: number) => `http://${h.bridgeHost || 'host.docker.internal'}:${port}`;

/** fetch with a forced Host header (global fetch ignores it). The bridge only accepts a loopback Host. */
function bridgeFetch(h: HostCfg): typeof fetch {
  return ((input: any, init: any = {}) => new Promise<Response>((resolve, reject) => {
    const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host = `127.0.0.1:${u.port}`;
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? 'GET', headers, signal: init.signal }, (res) => {
      const nobody = [204, 205, 304].includes(res.statusCode ?? 0);
      resolve(new Response(nobody ? null : (Readable.toWeb(res) as any), { status: res.statusCode, statusText: res.statusMessage, headers: res.headers as any }));
    });
    req.on('error', reject);
    req.end(init.body);
  })) as typeof fetch;
}

async function manualStatus(h: HostCfg, p: ProfileCfg): Promise<Status> {
  const f = bridgeFetch(h);
  const up = await Promise.all((p.bridgePort ? [p.bridgePort] : BRIDGE_PORTS).map((port) => f(`${bridgeAddr(h, port)}/ping`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500 ? port : 0, () => 0)));
  const port = up.find(Boolean);
  return port ? { bridge: { pid: 0, port, token: h.bridgeToken ?? '' } } : {};
}

/** What the user must run on the machine that hosts the browser (no ssh for this host). */
function manualInstructions(h: HostCfg, p: ProfileCfg) {
  const os = h.os;
  if (os !== 'macos' && os !== 'linux') throw new Error(`host ${h.name}: set Operating system to macos or linux (Windows has no manual mode)`);
  if (!h.homeDir) throw new Error(`host ${h.name}: set "Home directory" (e.g. /Users/you) so the setup commands can use absolute paths`);
  const pf = platforms[os];
  const home = h.homeDir.replace(/\/+$/, '');
  const ex = (x: string) => (x.startsWith('~/') ? home + x.slice(1) : x);
  const x = paths(h, pf, p);
  const bp = ex((h.browserpawDir || '~/dev/browserpaw').replace(/[\\/]+$/, ''));
  const [ext, nh, dir] = [ex(x.ext), ex(x.nativeHost), ex(x.profile!)];
  const node = [
    'const fs=require("fs"),c=require("crypto"),[ext,d,nh,tp]=process.argv.slice(1);',
    'let k;try{k=require(ext+"/manifest.json").key}catch(e){}',
    'const id=[...c.createHash("sha256").update(k?Buffer.from(k,"base64"):Buffer.from(ext)).digest("hex").slice(0,32)].map(x=>String.fromCharCode(97+parseInt(x,16))).join("");',
    'fs.writeFileSync(d+"/browserpaw-host.sh","#!/bin/sh\\nexport CHROME_MCP_TOOL_PROFILE="+tp+"\\nexec \\""+nh+"\\" \\"$@\\"\\n",{mode:0o700});',
    `fs.writeFileSync(d+"/NativeMessagingHosts/${HOST_NAME}.json",JSON.stringify({name:"${HOST_NAME}",description:"BrowserPaw (MControlProgram profile ${p.name})",path:d+"/browserpaw-host.sh",type:"stdio",allowed_origins:["chrome-extension://"+id+"/"]},null,2),{mode:0o600});`,
  ].join('');
  const launch = pf.launch({ dir, ext, nativeHost: nh, chromium: ex(x.chromium), extensionId: '' }, { browser: h.browser ?? 'chromium', toolProfile: p.toolProfile || 'full', headless: !!p.headless, extraArgs: p.extraArgs ?? '', proxy: p.proxy?.trim() || undefined, proxyBypass: p.proxyBypass?.trim() || undefined, pwnfoxColor: p.pwnfoxColor || undefined, env: launchEnv(h, pf), task: '' });
  const script = [
    'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1',
    'set -e',
    `[ -d ${q(bp)}/.git ] || git clone ${q(h.repoUrl || DEFAULT_REPO)} ${q(bp)}`,
    `if [ ! -d ${q(ext)} ] || [ ! -f ${q(nh)} ]; then (cd ${q(bp)} && { command -v pnpm >/dev/null || corepack enable pnpm; } && pnpm install && pnpm build); fi`,
    `mkdir -p ${q(dir + '/NativeMessagingHosts')}`,
    `node -e '${node}' ${q(ext)} ${q(dir)} ${q(nh)} ${q(p.toolProfile || 'full')}`,
    launch,
  ].join('\n');
  return {
    steps: [
      `1. Open a terminal on ${h.name} (the machine that will show the browser), logged in as the user who should own it. It needs git, node >= 22.6 and ${h.browser ?? 'chromium'} installed.`,
      '2. Paste and run the script below. The first run clones and builds BrowserPaw (several minutes) and then opens the browser; later runs just open it.',
      '3. First time only: once the browser is open, run `cat ~/.chrome-mcp/bridge-token` in that terminal and paste the result into this host\'s "Bridge token" field.',
      `4. Press Status here. When the bridge is reachable at ${bridgeAddr(h, p.bridgePort ?? 12306)} (ports 12306-12316) the profile is ready.`,
    ],
    script,
  };
}

async function status(ssh: SshApi, h: HostCfg, p: ProfileCfg, log: Log): Promise<Status> {
  if (h.manual) return manualStatus(h, p);
  const pf = await platformOf(ssh, h, log);
  return parseStatus((await run(ssh, h, pf, pf.status(paths(h, pf, p).profile!), log)).stdout);
}

/** Set up the profile and launch Chromium if it is not running; wait for its bridge. */
async function startProfile(ssh: SshApi, h: HostCfg, p: ProfileCfg, timeoutSec: number, log: Log) {
  let st = await status(ssh, h, p, log);
  if (st.bridge) return st;
  if (h.manual) throw new Error(`profile ${p.name}: its browser is not running on ${h.name}, which is a manual host (no ssh). An admin must run "Set up & start" on the plugin page and follow the commands it shows.`);
  const pf = await platformOf(ssh, h, log);
  if (!st.chromiumPid) {
    const r = await setupProfile(ssh, h, p, log);
    await run(ssh, h, pf, pf.launch(r, { browser: h.browser ?? 'chromium', toolProfile: p.toolProfile || 'full', headless: !!p.headless, extraArgs: p.extraArgs ?? '', proxy: p.proxy?.trim() || undefined, proxyBypass: p.proxyBypass?.trim() || undefined, pwnfoxColor: p.pwnfoxColor || undefined, env: launchEnv(h, pf), task: `MControlProgram-BrowserPaw-${p.name}` }), log);
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

/** JSON over the bridge's plain HTTP routes (fork: /url-policy*), same token as /mcp. */
const bridgeCall = (f: typeof fetch, base: string, token: string): BridgeCall => async (method, path, body) => {
  const r = await f(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) throw new Error('this BrowserPaw build has no URL policy support (needs the clarkehackworth fork; update the checkout and rebuild)');
  return r.json().catch(() => ({ status: 'error', error: `HTTP ${r.status}` }));
};

async function connectBridge(ssh: SshApi, h: HostCfg, bridge: NonNullable<Status['bridge']>, log: Log) {
  ssh = via(ssh, h);
  if (h.manual) {
    if (!bridge.token) throw new Error(`host ${h.name}: set "Bridge token" (run \`cat ~/.chrome-mcp/bridge-token\` on the host)`);
    const transport = new StreamableHTTPClientTransport(new URL(`${bridgeAddr(h, bridge.port)}/mcp`), { fetch: bridgeFetch(h), requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } });
    const client = new Client({ name: 'mcontrolprogram', version: '0.1.0' });
    await client.connect(transport);
    return { client, call: bridgeCall(bridgeFetch(h), bridgeAddr(h, bridge.port), bridge.token) };
  }
  const t = await ssh.openTunnel(h.sshHost, '127.0.0.1', bridge.port, log);
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } });
    const client = new Client({ name: 'mcontrolprogram', version: '0.1.0' });
    await client.connect(transport);
    const onclose = transport.onclose; // the tunnel lives exactly as long as the transport
    transport.onclose = () => { t.close(); onclose?.(); };
    return { client, call: bridgeCall(fetch, `http://127.0.0.1:${t.port}`, bridge.token) };
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
  required: ['name'],
  'x-kind-column': { title: 'Type', flags: { native: 'Native', manual: 'Manual' }, default: 'SSH' },
  properties: {
    name: { type: 'string', title: 'Name', pattern: NAME.source, 'x-pattern-hint': 'letters, digits, _ and -' },
    native: { type: 'boolean', title: 'Native (this machine)', description: 'Run the browser on the machine MControlProgram itself runs on (inside its container if it is containerised, so the browser, git, node and a display must exist there). Commands run locally; no ssh, and the bridge is reached on 127.0.0.1. Paths and ~ are the MControlProgram user\'s.', default: false },
    manual: { type: 'boolean', title: 'Manual (no ssh)', description: 'The browser runs on a machine MControlProgram cannot ssh to (e.g. the docker host). You run the setup commands yourself ("Set up & start" shows them) and MControlProgram reaches the BrowserPaw bridge over http at the address below.', default: false },
    homeDir: { type: 'string', title: 'Home directory (manual)', 'x-no-column': true, description: 'Absolute home of the user running the browser, e.g. /Users/you or /home/you. Manual hosts only.' },
    bridgeHost: { type: 'string', title: 'Bridge address (manual)', 'x-no-column': true, description: 'Host the BrowserPaw bridge (127.0.0.1 on the browser machine) is reachable at from MControlProgram. Empty = host.docker.internal (Docker Desktop forwards it to the host loopback).' },
    bridgeToken: { type: 'string', title: 'Bridge token (manual)', 'x-no-column': true, description: 'Output of `cat ~/.chrome-mcp/bridge-token` on the browser machine (exists after the browser has started once). Manual hosts only.', format: 'password', 'x-secret': true },
    sshHost: { type: 'string', title: 'SSH host', description: 'Host from the SSH plugin inventory (must have a pinned host key). MControlProgram runs setup commands as that user. Not used for manual hosts.', 'x-options-from': 'ssh:hosts' },
    os: { type: 'string', title: 'Operating system', enum: ['auto', 'linux', 'macos', 'windows'], default: 'auto', description: 'auto: detected over ssh (uname, else PowerShell). Windows needs OpenSSH Server and PowerShell; macOS and Linux need sh.' },
    browser: { type: 'string', title: 'Browser', enum: ['chromium', 'chrome', 'edge'], default: 'chromium', description: 'Picks the default binary path and, on Windows, the registry key for native messaging. Branded Chrome/Edge get --disable-features=DisableLoadExtensionCommandLineSwitch so --load-extension still works.' },
    description: { type: 'string', title: 'Description' },
    browserpawDir: { type: 'string', title: 'BrowserPaw checkout', description: 'Built BrowserPaw repo on the host (pnpm build). Native host: <dir>/app/native-server/dist/run_host.sh (run_host.bat on Windows). ~/ means the ssh user\'s home on every OS.', default: '~/dev/browserpaw' },
    repoUrl: { type: 'string', title: 'BrowserPaw repo URL', description: 'Cloned into the checkout dir by "Set up & start" when the extension or native host is missing (then pnpm install && pnpm build; needs git and node on the host). Empty = ' + DEFAULT_REPO },
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
    bridgePort: { type: 'integer', title: 'Bridge port (manual hosts)', description: 'Pin the bridge port (12306-12316) of this profile\'s browser. Empty = the first port that answers, which is only right with one running profile per manual host.', minimum: 12306, maximum: 12316 },
    toolProfile: { type: 'string', title: 'BrowserPaw tool profile', enum: ['core', 'full', 'crawl'], default: 'full' },
    headless: { type: 'boolean', title: 'Headless', description: 'No window (human handoff for 2FA/captchas will not be possible)', default: false },
    autoStart: { type: 'boolean', title: 'Start on demand', description: 'Launch Chromium when an agent calls a tool and the profile is not running', default: true },
    proxy: { type: 'string', title: 'Proxy server', description: 'Chromium --proxy-server, e.g. socks5://10.0.0.5:1080, http://proxy.lan:3128, or per-scheme rules like http=p1:3128;https=p2:3128. Empty = the system proxy settings. Applies when the browser starts; use Stop, then start again, after changing it. Credentials are not supported (Chromium ignores user:pass here and would prompt); use an IP-allowlisted proxy or a local unauthenticated forwarder.', pattern: '^[^\\s\'"@]+$', 'x-pattern-hint': 'no spaces, quotes or user:pass@' },
    proxyBypass: { type: 'string', title: 'Proxy bypass list', description: 'Chromium --proxy-bypass-list, semicolon-separated, e.g. *.lan;192.168.0.0/16. Loopback is always direct (the BrowserPaw bridge is unaffected).', pattern: '^[^\\s\'"]+$', 'x-pattern-hint': 'no spaces or quotes; separate entries with ;' },
    pwnfoxColor: { type: 'string', title: 'PwnFox colour', enum: ['', ...PWNFOX_COLORS], default: '', description: 'Empty = off. Loads PwnFox-for-Chromium style extensions: adds an x-pwnfox-color header to every request (Burp colours this profile\'s traffic) and tints the window frame. macOS/Linux hosts only. Applies when the browser starts.' },
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
  description: 'Run isolated Chromium profiles with the BrowserPaw extension on SSH hosts and give agents their browser tools. MControlProgram sets up the profiles, launches Chromium and tunnels to the bridge; agents never get SSH access or the bridge token. Hosts without ssh can be "manual": the admin runs the shown setup script and MControlProgram reaches the bridge over http.',
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
    ...policy.actions,
    check_host: {
      title: 'Check host', inventory: 'hosts',
      async run({ name }, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === name); if (!h) throw new Error('unknown host');
        if (h.manual) { const ok = !!(await manualStatus(h, { name: '', host: h.name })).bridge; return { ok, manual: true, message: ok ? 'a BrowserPaw bridge answers' : `no BrowserPaw bridge answers at ${bridgeAddr(h, 12306)} (ports 12306-12316): start a profile's browser first (see Set up & start)` }; }
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
        if (h.manual && !(await status(ssh, h, p, a.log)).bridge) return { ok: false, manual: true, message: 'The browser is not reachable yet. Run the script below on the browser machine, then press Set up & start again.', ...manualInstructions(h, p) };
        const st = await startProfile(ssh, h, p, g.startTimeoutSec, a.log);
        const { client, call } = await connectBridge(ssh, h, st.bridge!, a.log);
        try {
          await policy.push(p.name, call).catch((e) => a.log.warn((e as Error).message));
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
        if (h.manual) return { ok: false, manual: true, message: 'Manual host: close the browser window (or quit that Chromium profile) on the browser machine.' };
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
        return { dir: st.dir ?? (h.manual ? 'manual host' : 'not set up'), running: !!st.chromiumPid || !!(h.manual && st.bridge), chromiumPid: st.chromiumPid, bridgePort: st.bridge?.port, cachedTools: cachedTools(p.name).length };
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

    const conns = new Map<string, { client: Client; call: BridgeCall; lastUsed: number }>();
    const connecting = new Map<string, Promise<Client>>();
    let reaper: NodeJS.Timeout | undefined;
    let puller: NodeJS.Timeout | undefined;
    let unlisten: (() => void) | undefined;
    const allowed = (tool: string) => !cfg.denyTools.includes(tool) && (cfg.allowTools.length === 0 || cfg.allowTools.includes(tool));

    const client = (name: string): Promise<Client> => {
      const c = conns.get(name);
      if (c) { c.lastUsed = Date.now(); return policy.ensureSynced(name, c.call).then(() => c.client); }
      let p = connecting.get(name);
      if (!p) {
        p = (async () => {
          const { p: prof, h } = lookup(g, name);
          let st = await status(ssh, h, prof, ctx.log);
          if (!st.bridge) {
            if (prof.autoStart === false) throw new Error(`profile ${name} is not running and "Start on demand" is off; ask an admin to start it`);
            st = await startProfile(ssh, h, prof, g.startTimeoutSec, ctx.log);
          }
          const { client: cl, call } = await connectBridge(ssh, h, st.bridge!, ctx.log);
          // Fail closed: no tool call reaches a browser that isn't enforcing the current URL policy.
          try { await policy.push(name, call); } catch (e) { await cl.close().catch(() => {}); throw e; }
          cl.onclose = () => { const cur = conns.get(name); if (cur?.client === cl) { conns.delete(name); void policy.pull(name, call); } };
          conns.set(name, { client: cl, call, lastUsed: Date.now() });
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

    const policyTool: ToolDefinition = {
      name: 'policy',
      description: 'Show the administrator\'s browser URL policy (default allow/deny and the block/allow rules). Every profile enforces it on everything the browser loads; non-web schemes (file:, chrome:, ssh:, ...) are always refused.',
      annotations: { readOnlyHint: true },
      handler: async () => text(JSON.stringify({ defaultPolicy: policy.store.policy(), rules: policy.store.rules().map(({ action, kind, value }) => ({ action, kind, value })) }, null, 2)),
    };

    const tools: ToolDefinition[] = [];
    // In place: the runtime holds this array, so sessions opened after a refresh see new tools.
    function rebuild() {
      const byName = new Map<string, CachedTool>();
      for (const n of names) for (const t of cachedTools(n)) if (!byName.has(t.name) && allowed(t.name)) byName.set(t.name, t);
      tools.splice(0, tools.length, profilesTool, policyTool, ...[...byName.values()].map((t): ToolDefinition => ({
        name: t.name, title: t.title, description: t.description ?? '', jsonSchema: withProfile(t.inputSchema), annotations: t.annotations,
        async handler(args, call) {
          try {
            const { profile, ...rest } = args ?? {};
            const name = pick(profile);
            const prepared = policy.prepareCall(name, t.name, rest, call);
            const run = async () => (await (await client(name)).callTool({ name: t.name, arguments: prepared }, undefined, { signal: call.signal, timeout: g.callTimeoutMs })) as unknown as ToolResult;
            try { return await run(); } catch (e) {
              // The browser (and so its bridge) restarted: our cached MCP session is gone. Reconnect once.
              if (!/MCP session ID/i.test((e as Error).message)) throw e;
              const stale = conns.get(name); conns.delete(name); void stale?.client.close().catch(() => {});
              ctx.log.info(`browserpaw ${name}: bridge session expired (browser restarted?), reconnecting`);
              return await run();
            }
          } catch (e) { return errorResult(e); }
        },
      })));
    }
    rebuild();

    return {
      tools,
      instructions: `Browser automation (BrowserPaw):
- Every browser tool requires a \`profile\` argument. Call {prefix}_profiles first to see the profiles, which host each runs on, and whether it is running. Stopped profiles may start on demand (the first call can be slow).
- Typical flow: {prefix}_get_windows_and_tabs, then {prefix}_chrome_navigate {url, background: true}, then {prefix}_chrome_read_dom (numbered elements) or {prefix}_chrome_get_markdown (article text), then act by number with {prefix}_chrome_interact_index / {prefix}_chrome_fill_index.
- Prefer the numbered tools over CSS selectors; use {prefix}_chrome_batch_actions for 2+ predictable steps.
- Use screenshots / {prefix}_chrome_computer only for canvas or unlabeled UIs. For CAPTCHA, 2FA or payments, call {prefix}_chrome_request_human_intervention.
- Close tabs you opened when done.
- The administrator's URL policy applies to everything the browser loads (see {prefix}_policy). Blocked URLs fail; don't retry them or look for workarounds.`,
      start() {
        // Learn tools from profiles that are already running; never launch browsers at gateway start.
        for (const n of names) if (cachedTools(n).length === 0) {
          const { p, h } = lookup(g, n);
          void status(ssh, h, p, ctx.log).then((st) => (st.bridge ? client(n) : undefined)).catch((e) => ctx.log.warn(`browserpaw ${n}: ${(e as Error).message}`));
        }
        // Rule changes reach every connected browser right away; the 3 s pull also re-pushes on a rev mismatch.
        unlisten = policy.store.onChange(() => { for (const [n, c] of conns) void policy.push(n, c.call).catch((e) => ctx.log.warn((e as Error).message)); });
        puller = setInterval(() => { for (const [n, c] of conns) void policy.pull(n, c.call); }, 3_000);
        puller.unref();
        reaper = setInterval(() => {
          policy.prune(ctx.global().logRetentionDays);
          const idle = effective(cfg.idleDisconnectSec, ctx.global().connectionIdleSec) * 1000;
          for (const [n, c] of conns) if (Date.now() - c.lastUsed > idle) { conns.delete(n); void policy.pull(n, c.call).finally(() => c.client.close()); ctx.log.debug(`idle disconnect ${n}`); }
        }, 30_000).unref();
      },
      async stop() {
        clearInterval(reaper); clearInterval(puller); unlisten?.();
        await Promise.all([...conns].map(([n, c]) => policy.pull(n, c.call)));
        for (const c of conns.values()) await c.client.close().catch(() => {});
        conns.clear();
      },
      status: () => { const sy = policy.syncStatus(); return { profiles: names.map((n) => ({ name: n, connected: conns.has(n), cachedTools: cachedTools(n).length, urlPolicy: sy[n] ?? null })) }; },
    };
  },
};

export default plugin;
