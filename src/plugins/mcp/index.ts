/**
 * MCP pass-through plugin: MControlProgram connects to external MCP servers (Streamable HTTP or stdio),
 * holds their credentials, and re-exposes their tools so every call goes through MControlProgram's
 * auth, logging and approval gate. Upstream tool schemas and annotations are forwarded unchanged.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MControlProgramPlugin, PluginContext, PluginInstance, ToolDefinition, ToolResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { setting } from '../../core/db.js';
import { encrypt, decrypt } from '../../core/crypto.js';
import { config as mcontrolprogramConfig } from '../../core/config.js';
import { pluginConfig } from '../../core/store.js';
import { openTunnel, type HostCfg } from '../ssh/index.js';
import { ask } from '../../core/plugin-api.js';
import * as toolRules from './rules.js';

interface ServerCfg {
  name: string; description?: string; transport: 'http' | 'stdio';
  url?: string; auth: 'none' | 'bearer' | 'header' | 'oauth'; token?: string; headerName?: string; sshHost?: string;
  command?: string; args?: string; env?: string; cwd?: string;
}
interface GlobalCfg { servers: ServerCfg[]; callTimeoutMs: number }
interface Cfg { servers: string[]; serversDisabled?: string[]; flat: boolean; allowTools: string[]; denyTools: string[]; idleDisconnectSec: number }

const serverSchema = {
  type: 'object',
  required: ['name', 'transport'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'Prefix for its tools (e.g. github → github_create_issue)', pattern: '^[a-zA-Z0-9_-]+$' },
    description: { type: 'string', title: 'Description', 'x-no-column': true },
    transport: { type: 'string', title: 'Transport', enum: ['http', 'stdio'], default: 'http' },
    url: { type: 'string', title: 'URL', 'x-column-title': 'URL / command', 'x-column-fallback': 'command', description: 'Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp', 'x-show-if': { transport: 'http' } },
    sshHost: { type: 'string', title: 'Reach via SSH host (optional)', 'x-no-column': true, description: 'Name of a host in the SSH plugin (must have a pinned host key). The URL is then resolved on that host, like ssh -L: e.g. http://127.0.0.1:12306/mcp is the remote machine\'s localhost. http only; not with OAuth.', 'x-show-if': { transport: 'http' } },
    auth: { type: 'string', title: 'Authentication', 'x-no-column': true, enum: ['none', 'bearer', 'header', 'oauth'], default: 'none', 'x-show-if': { transport: 'http' } },
    token: { type: 'string', title: 'Token / header value', 'x-secret': true, 'x-show-if': { auth: ['bearer', 'header'] } },
    headerName: { type: 'string', title: 'Header name', 'x-no-column': true, default: 'X-API-Key', 'x-show-if': { auth: 'header' } },
    command: { type: 'string', title: 'Command', 'x-no-column': true, description: 'Executable to spawn, e.g. npx', 'x-show-if': { transport: 'stdio' } },
    args: { type: 'string', title: 'Arguments', description: 'One per line', format: 'multiline', 'x-show-if': { transport: 'stdio' } },
    env: { type: 'string', title: 'Environment', description: 'KEY=VALUE per line; secrets go here, the agent never sees them', format: 'multiline', 'x-secret': true, 'x-show-if': { transport: 'stdio' } },
    cwd: { type: 'string', title: 'Working directory', 'x-no-column': true, 'x-show-if': { transport: 'stdio' } },
  },
};

// ---- OAuth client state, encrypted in settings (kept out of the config form) ----
const oauthKey = (name: string) => `mcp.oauth.${name}`;
const loadOauth = (name: string): { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string } => {
  const raw = setting.get(oauthKey(name)); return raw ? JSON.parse(decrypt(raw)) : {};
};
const saveOauth = (name: string, patch: Record<string, unknown>) => setting.set(oauthKey(name), encrypt(JSON.stringify({ ...loadOauth(name), ...patch })));
// state nonce → server name, one live per server, 10 min. The callback only accepts a state we issued (RFC 6749 §10.12).
const flows = new Map<string, { name: string; exp: number }>();
const newFlow = (name: string) => {
  for (const [k, f] of flows) if (f.name === name || f.exp < Date.now()) flows.delete(k);
  const n = randomBytes(24).toString('base64url'); flows.set(n, { name, exp: Date.now() + 600_000 }); return n;
};
const pendingAuth = new Map<string, URL>(); // server name → authorization URL captured during connect
const redirectUrl = () => `${mcontrolprogramConfig.publicUrl ?? `http://${mcontrolprogramConfig.adminHost}:${mcontrolprogramConfig.adminPort}`}/api/plugins/mcp/callback`;

function oauthProvider(name: string): OAuthClientProvider {
  return {
    get redirectUrl() { return redirectUrl(); },
    get clientMetadata() { return { client_name: 'MControlProgram', redirect_uris: [redirectUrl()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    state: () => newFlow(name),
    clientInformation: () => loadOauth(name).client,
    saveClientInformation: (client) => saveOauth(name, { client }),
    tokens: () => loadOauth(name).tokens,
    saveTokens: (tokens) => saveOauth(name, { tokens }),
    redirectToAuthorization: (url) => { pendingAuth.set(name, url); },
    saveCodeVerifier: (verifier) => saveOauth(name, { verifier }),
    codeVerifier: () => loadOauth(name).verifier ?? '',
  };
}

const lines = (s?: string) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

function makeTransport(s: ServerCfg) {
  if (s.transport === 'stdio') {
    if (!s.command) throw new Error(`server ${s.name}: command required`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const l of lines(s.env)) { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
    return new StdioClientTransport({ command: s.command, args: lines(s.args), env, cwd: s.cwd || undefined, stderr: 'ignore' });
  }
  if (!s.url) throw new Error(`server ${s.name}: url required`);
  const headers: Record<string, string> = {};
  if (s.auth === 'bearer' && s.token) headers.authorization = `Bearer ${s.token}`;
  if (s.auth === 'header' && s.token) headers[s.headerName || 'X-API-Key'] = s.token;
  return new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers }, authProvider: s.auth === 'oauth' ? oauthProvider(s.name) : undefined });
}

/** If the server is reached through an SSH host, open the tunnel and return the server with its URL pointed at the local end. */
async function viaTunnel(s: ServerCfg, log: PluginContext['log']) {
  if (s.transport !== 'http' || !s.sshHost) return { s, close: () => {} };
  if (s.auth === 'oauth') throw new Error(`server ${s.name}: OAuth is not supported through an SSH host`);
  const u = new URL(s.url ?? '');
  if (u.protocol !== 'http:') throw new Error(`server ${s.name}: only http:// URLs can go through an SSH host`);
  const g = pluginConfig.decrypted('ssh') as { hosts?: HostCfg[]; connectTimeoutMs: number; keepaliveSec: number };
  const h = g.hosts?.find((x) => x.name === s.sshHost);
  if (!h) throw new Error(`server ${s.name}: ssh host "${s.sshHost}" is not in the SSH plugin inventory`);
  const t = await openTunnel(h, g, u.hostname, Number(u.port) || 80, log);
  u.host = `127.0.0.1:${t.port}`;
  return { s: { ...s, url: u.toString() }, close: t.close };
}

/** Connect and return the client; for OAuth servers that need authorization, throws UnauthorizedError after capturing the URL. */
async function connect(s0: ServerCfg, log: PluginContext['log']): Promise<{ client: Client; transport: ReturnType<typeof makeTransport> }> {
  const { s, close } = await viaTunnel(s0, log);
  try {
    const transport = makeTransport(s);
    const client = new Client({ name: 'mcontrolprogram', version: '0.1.0' });
    await client.connect(transport);
    const onclose = transport.onclose; // set by client.connect; the tunnel lives exactly as long as the transport
    transport.onclose = () => { close(); onclose?.(); };
    return { client, transport };
  } catch (e) { close(); throw e; }
}

const plugin: MControlProgramPlugin = {
  id: 'mcp',
  name: 'MCP pass-through',
  version: '0.1.0',
  description: 'Proxy external MCP servers (HTTP or stdio): MControlProgram holds their credentials and re-exposes their tools with a call log, an expose/hide list, and per-tool allow/ask/deny rules.',
  globalConfigSchema: {
    type: 'object',
    properties: {
      servers: { type: 'array', title: 'Upstream MCP servers', items: serverSchema, default: [] },
      callTimeoutMs: { type: 'integer', title: 'Tool call timeout (ms)', default: 60000 },
    },
  },
  defaultGlobalConfig: { servers: [], callTimeoutMs: 60000 },
  onRenamed: (key, from, to) => { if (key === 'servers') toolRules.renameUpstream(from, to); },
  globalActions: {
    ...toolRules.actions,
    test_server: {
      title: 'Test server',
      async run({ name }, { config, log }) {
        const s = (config.servers as ServerCfg[]).find((x) => x.name === name);
        if (!s) throw new Error('unknown server');
        try {
          const { client } = await connect(s, log);
          const list = (await client.listTools()).tools;
          await client.close();
          toolRules.seen(s.name, list);
          return { ok: true, serverInfo: client.getServerVersion?.(), tools: list.map((t) => t.name) };
        } catch (e) {
          if (e instanceof UnauthorizedError) return { ok: false, needsAuthorization: true, authorizeUrl: pendingAuth.get(s.name)?.toString(), error: 'not authorized: run "Authorize (OAuth)"' };
          throw e;
        }
      },
    },
    oauth_start: {
      title: 'Authorize (OAuth)',
      when: { auth: 'oauth' },
      async run({ name }, { config, log }) {
        const s = (config.servers as ServerCfg[]).find((x) => x.name === name);
        if (!s) throw new Error('unknown server');
        if (s.auth !== 'oauth') throw new Error('server is not configured for OAuth');
        pendingAuth.delete(name);
        try { const { client } = await connect(s, log); await client.close(); return { ok: true, alreadyAuthorized: true }; }
        catch (e) {
          if (!(e instanceof UnauthorizedError)) throw e;
          const url = pendingAuth.get(name)?.toString();
          if (!url) throw new Error('authorization server did not provide an authorization URL');
          return { ok: true, authorizeUrl: url, note: 'Open the URL, sign in and approve; the server redirects back to MControlProgram.' };
        }
      },
    },
    callback: {
      title: 'OAuth callback (internal)',
      async run({ code, state, error, error_description }, { config }) {
        if (error) throw new Error(`${error}: ${error_description ?? ''}`);
        const flow = flows.get(String(state)); flows.delete(String(state));
        if (!flow || flow.exp < Date.now()) throw new Error('unknown or expired authorization flow; start it again from the MCP plugin page');
        const s = (config.servers as ServerCfg[]).find((x) => x.name === flow.name);
        if (!s || !code) throw new Error('unknown server or missing code');
        const transport = makeTransport(s) as StreamableHTTPClientTransport;
        await transport.finishAuth(String(code));
        saveOauth(s.name, { verifier: undefined });
        return { ok: true, name: s.name };
      },
    },
    oauth_reset: {
      title: 'Forget OAuth tokens',
      when: { auth: 'oauth' },
      async run({ name }) { setting.set(oauthKey(String(name)), encrypt('{}')); return { ok: true }; },
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      servers: { type: 'array', title: 'Servers to expose', description: 'Empty = no servers.', items: { type: 'string', 'x-options-from': 'servers' }, 'x-disabled-key': 'serversDisabled', default: [] },
      serversDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true, default: [] },
      flat: { type: 'boolean', title: 'Flat tool names', description: 'Do not prefix tool names with the server name (use when exposing a single server)', default: false },
      allowTools: { type: 'array', title: 'Expose only these tools', description: 'Upstream tool names (or server/tool); empty = all. Hidden tools are not listed to agents. To allow, ask or deny calls to exposed tools, use Access rules on the MCP pass-through plugin page.', items: { type: 'string' }, default: [] },
      denyTools: { type: 'array', title: 'Hide these tools', description: 'Upstream tool names (or server/tool). Wins over the expose list.', items: { type: 'string' }, default: [] },
      idleDisconnectSec: { type: 'integer', title: 'Idle disconnect (seconds)', description: '0 = MControlProgram default', default: 0 },
    },
  },
  defaultConfig: { servers: [], flat: false, allowTools: [], denyTools: [], idleDisconnectSec: 0 },

  create(ctx: PluginContext): PluginInstance {
    const cfg = ctx.config as Cfg;
    const g = ctx.pluginConfig as GlobalCfg;
    const active = cfg.servers.filter((n) => !(cfg.serversDisabled ?? []).includes(n));
    const selected = g.servers.filter((s) => active.includes(s.name));
    for (const n of cfg.servers) if (!g.servers.some((s) => s.name === n)) ctx.log.warn(`server "${n}" is not configured on the mcp plugin`);

    const conns = new Map<string, { client: Client; lastUsed: number }>();
    const tools: ToolDefinition[] = [];
    let reaper: NodeJS.Timeout | undefined;

    const allowed = (server: string, tool: string) => {
      const ids = [tool, `${server}/${tool}`];
      if (cfg.denyTools.some((d) => ids.includes(d))) return false;
      return cfg.allowTools.length === 0 || cfg.allowTools.some((a) => ids.includes(a));
    };

    const client = async (s: ServerCfg): Promise<Client> => {
      const c = conns.get(s.name);
      if (c) { c.lastUsed = Date.now(); return c.client; }
      const { client } = await connect(s, ctx.log);
      client.onclose = () => { if (conns.get(s.name)?.client === client) conns.delete(s.name); };
      conns.set(s.name, { client, lastUsed: Date.now() });
      ctx.log.debug(`connected to ${s.name}`);
      return client;
    };

    return {
      tools,
      async start() {
        for (const s of selected) {
          try {
            const c = await client(s);
            const list = (await c.listTools()).tools;
            toolRules.seen(s.name, list);
            let n = 0;
            for (const t of list) {
              if (!allowed(s.name, t.name)) continue;
              n++;
              tools.push({
                name: cfg.flat ? t.name : `${s.name}_${t.name}`,
                title: t.title,
                description: t.description ?? '',
                jsonSchema: t.inputSchema as Record<string, any>,
                annotations: t.annotations as ToolDefinition['annotations'],
                async handler(args, call) {
                  const t0 = Date.now();
                  const entry = { serverId: ctx.serverId, instance: ctx.instanceName, principal: call.principal, upstream: s.name, tool: t.name, args };
                  const rec = (e: Partial<toolRules.LogEntry>) => { try { toolRules.record({ ...entry, ...e }); } catch (err) { ctx.log.warn(`call log write failed: ${(err as Error).message}`); } };
                  // read live per call: rule changes apply without reconnecting
                  const v = toolRules.verdict(s.name, t.name);
                  if (v.action === 'deny') { rec({ blocked: v.by }); throw new Error(`${s.name}/${t.name} is disabled by the administrator. Tell the user if you need it.`); }
                  let allowedBy = v.by;
                  if (v.action === 'ask') {
                    try { allowedBy = await ask(call, { feature: 'mcp_tool', summary: `${s.name}/${t.name}`, reason: v.by, subject: { upstream: s.name, tool: t.name, args } }); }
                    catch (e) { rec({ blocked: `awaiting approval: ${v.by}` }); throw e; }
                  }
                  try {
                    const c = await client(s);
                    const r = await c.callTool({ name: t.name, arguments: args }, undefined, { signal: call.signal, timeout: g.callTimeoutMs }) as unknown as ToolResult;
                    rec({ allowedBy, ms: Date.now() - t0, error: r.isError ? String((r.content?.[0] as any)?.text ?? 'error').slice(0, 500) : undefined });
                    return r;
                  } catch (e) { rec({ allowedBy, ms: Date.now() - t0, error: String((e as Error).message ?? e) }); throw e; }
                },
              });
            }
            ctx.log.info(`${s.name}: exposing ${n}/${list.length} tools`);
          } catch (e) {
            ctx.log.error(`${s.name}: ${e instanceof UnauthorizedError ? 'not authorized (run Authorize in plugin config)' : String((e as Error).message ?? e)}; no tools exposed`);
          }
        }
        // ponytail: idle sockets closed by the reaper reconnect transparently on the next call
        reaper = setInterval(() => {
          const idle = effective(cfg.idleDisconnectSec, ctx.global().connectionIdleSec) * 1000;
          for (const [name, c] of conns) if (Date.now() - c.lastUsed > idle) { conns.delete(name); void c.client.close(); ctx.log.debug(`idle disconnect ${name}`); }
        }, 30_000).unref();
      },
      async stop() {
        clearInterval(reaper);
        for (const [, c] of conns) await c.client.close().catch(() => {});
        conns.clear();
      },
      status: () => ({ servers: selected.map((s) => ({ name: s.name, transport: s.transport, connected: conns.has(s.name), tools: tools.filter((t) => cfg.flat || t.name.startsWith(`${s.name}_`)).length })) }),
    };
  },
};
export default plugin;
