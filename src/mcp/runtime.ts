/**
 * One running MCP server: an Express app on its own port, auth, per-agent sessions,
 * and the live set of plugin instances whose tools are exposed.
 */
import { z } from 'zod';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer, type RegisteredTool, type RegisteredResource } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { MControlProgramOAuthProvider } from './oauth.js';
import { servers as serverStore, instances as instanceStore, bearerTokens, pluginConfig, type ServerRecord, type PluginInstanceRecord } from '../core/store.js';
import { approvals } from '../core/approvals.js';
import { plugins } from '../core/plugin-loader.js';
import { ScopedLogger, log } from '../core/logger.js';
import { getGlobalConfig } from '../core/global-config.js';
import type { MControlProgramPlugin, PluginInstance, ToolDefinition } from '../core/plugin-api.js';

interface LiveInstance { record: PluginInstanceRecord; plugin: MControlProgramPlugin; instance: PluginInstance; error?: string; log: ScopedLogger }
interface Session {
  id: string; transport: StreamableHTTPServerTransport; mcp: McpServer; principal: string;
  startedAt: number; lastSeen: number; calls: number; clientInfo?: string;
  tools: Map<string, (RegisteredTool | RegisteredResource)[]>; // instanceId -> registered tools and resources
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

export class RunningServer {
  record: ServerRecord;
  private http?: HttpServer;
  readonly sessions = new Map<string, Session>();
  readonly live = new Map<string, LiveInstance>();
  private oauth?: MControlProgramOAuthProvider;
  readonly log: ScopedLogger;
  startedAt = 0;
  error?: string;

  constructor(record: ServerRecord) {
    this.record = record;
    this.log = new ScopedLogger({ serverId: record.id, category: 'server' }, () => this.record.log_level);
  }

  get publicUrl() {
    return (this.record.public_url || `http://${this.record.host === '0.0.0.0' ? 'localhost' : this.record.host}:${this.record.port}`).replace(/\/$/, '');
  }

  async start() {
    for (const rec of instanceStore.listForServer(this.record.id)) if (rec.enabled) await this.loadInstance(rec);
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '8mb' }));
    app.use(express.urlencoded({ extended: false }));
    app.use(cookieParser());

    const mode = this.record.auth_mode;
    if (mode === 'oauth' || mode === 'both') {
      this.oauth = new MControlProgramOAuthProvider(this.record.id, this.record.name);
      const issuer = new URL(this.publicUrl);
      app.use(mcpAuthRouter({ provider: this.oauth, issuerUrl: issuer, resourceServerUrl: new URL('/mcp', issuer), resourceName: this.record.name,
        clientRegistrationOptions: { rateLimit: false }, tokenOptions: { rateLimit: false }, authorizationOptions: { rateLimit: false }, revocationOptions: { rateLimit: false } }));
      app.post('/consent', (req, res) => this.oauth!.consent(req, res).catch((e) => res.status(500).send(String(e))));
    }
    app.get('/', (_req, res) => res.json({ mcontrolprogram: true, server: this.record.name, mcp: `${this.publicUrl}/mcp`, auth: mode }));
    app.all('/mcp', this.authMiddleware(), (req, res) => this.handleMcp(req, res));
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      this.log.error('http error', { error: String(err?.message ?? err) });
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(this.record.port, this.record.host, () => resolve());
      srv.on('error', reject);
      this.http = srv;
    });
    this.startedAt = Date.now();
    this.log.info(`MCP server "${this.record.name}" listening on ${this.record.host}:${this.record.port} (auth=${mode})`);
  }

  async stop() {
    for (const s of [...this.sessions.values()]) await this.closeSession(s.id, 'server stopping');
    for (const id of [...this.live.keys()]) await this.unloadInstance(id);
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.http?.closeAllConnections?.();
    this.log.info(`MCP server "${this.record.name}" stopped`);
  }

  // ---------- plugin instances ----------

  async loadInstance(rec: PluginInstanceRecord) {
    const plugin = plugins.get(rec.plugin_id);
    const ilog = new ScopedLogger({ serverId: this.record.id, pluginInstanceId: rec.id, category: `plugin:${rec.plugin_id}` }, () => this.record.log_level);
    if (!plugin) {
      this.live.set(rec.id, { record: rec, plugin: { id: rec.plugin_id } as MControlProgramPlugin, instance: { tools: [] }, error: `plugin "${rec.plugin_id}" not loaded`, log: ilog });
      ilog.error(`plugin ${rec.plugin_id} not available`);
      return;
    }
    try {
      const instance = await plugin.create({ instanceId: rec.id, instanceName: rec.name, serverId: this.record.id, config: instanceStore.decrypted(rec), pluginConfig: pluginConfig.decrypted(rec.plugin_id), global: getGlobalConfig, log: ilog });
      await instance.start?.();
      this.live.set(rec.id, { record: rec, plugin, instance, log: ilog });
      ilog.info(`plugin instance "${rec.name}" started (${instance.tools.length} tools)`);
      for (const s of this.sessions.values()) this.registerInstanceTools(s, this.live.get(rec.id)!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.live.set(rec.id, { record: rec, plugin, instance: { tools: [] }, error: msg, log: ilog });
      ilog.error(`failed to start plugin instance "${rec.name}": ${msg}`);
    }
  }

  async unloadInstance(id: string) {
    const li = this.live.get(id);
    if (!li) return;
    for (const s of this.sessions.values()) {
      for (const t of s.tools.get(id) ?? []) t.remove();
      s.tools.delete(id);
    }
    try { await li.instance.stop?.(); } catch (e) { li.log.warn(`stop failed: ${String(e)}`); }
    this.live.delete(id);
    li.log.info(`plugin instance "${li.record.name}" stopped`);
  }

  /** Re-read the instance record and restart it; live sessions get tools/list_changed. */
  async reloadInstance(id: string) {
    await this.unloadInstance(id);
    const rec = instanceStore.get(id);
    if (rec && rec.enabled && rec.server_id === this.record.id) await this.loadInstance(rec);
  }

  // ---------- auth ----------

  private authMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const mode = this.record.auth_mode;
      if (mode === 'none') { (req as any).auth = { token: '', clientId: 'anonymous', scopes: [], extra: { principal: 'anonymous' } } satisfies AuthInfo; return next(); }
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
      const fail = (desc: string) => {
        const parts = [`Bearer realm="mcontrolprogram"`, `error="invalid_token"`, `error_description="${desc}"`];
        if (this.oauth) parts.push(`resource_metadata="${this.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
        res.set('WWW-Authenticate', parts.join(', ')).status(401).json({ error: 'invalid_token', error_description: desc });
      };
      if (!m) return fail('missing bearer token');
      const token = m[1]!;
      if (mode === 'bearer' || mode === 'both') {
        const t = bearerTokens.verify(this.record.id, token);
        if (t) { (req as any).auth = { token, clientId: t.id, scopes: [], extra: { principal: `token:${t.name}` } } satisfies AuthInfo; return next(); }
      }
      if (this.oauth) {
        try { (req as any).auth = await this.oauth.verifyAccessToken(token); return next(); }
        catch (e) { return fail((e as Error).message); }
      }
      return fail('invalid token');
    };
  }

  // ---------- MCP sessions ----------

  private async handleMcp(req: Request, res: Response) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const auth = (req as any).auth as AuthInfo;
    const principal = String(auth.extra?.principal ?? auth.clientId);
    if (sid) {
      const s = this.sessions.get(sid);
      if (!s) { res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'session not found' }, id: null }); return; }
      s.lastSeen = Date.now();
      await s.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'missing session; send initialize first' }, id: null });
      return;
    }
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, onsessionclosed: (s) => void this.closeSession(s, 'client closed') });
    const mcp = new McpServer({ name: `mcontrolprogram:${sanitize(this.record.name)}`, version: '0.1.0' }, { instructions: this.record.instructions || undefined, capabilities: { tools: { listChanged: true }, resources: {}, logging: {} } });
    const session: Session = { id, transport, mcp, principal, startedAt: Date.now(), lastSeen: Date.now(), calls: 0, tools: new Map(),
      clientInfo: req.body?.params?.clientInfo ? `${req.body.params.clientInfo.name} ${req.body.params.clientInfo.version ?? ''}`.trim() : undefined };
    this.sessions.set(id, session);
    for (const li of this.live.values()) this.registerInstanceTools(session, li);
    transport.onclose = () => void this.closeSession(id, 'transport closed');
    await mcp.connect(transport);
    this.log.connection(`session opened by ${principal}${session.clientInfo ? ` (${session.clientInfo})` : ''}`, { principal, client: session.clientInfo }, id);
    await transport.handleRequest(req, res, req.body);
  }

  async closeSession(id: string, reason: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    for (const li of this.live.values()) { try { await li.instance.onSessionClosed?.(id); } catch { /* ignore */ } }
    try { await s.mcp.close(); } catch { /* ignore */ }
    this.log.connection(`session closed (${reason}) principal=${s.principal} calls=${s.calls}`, undefined, id);
  }

  private registerInstanceTools(session: Session, li: LiveInstance) {
    const prefix = sanitize(li.record.name || li.plugin.toolPrefix || li.plugin.id);
    const regs: (RegisteredTool | RegisteredResource)[] = [];
    for (const r of li.instance.resources ?? []) {
      try {
        regs.push(session.mcp.registerResource(`${prefix}_${sanitize(r.name)}`, r.uri, { description: r.description, mimeType: r.mimeType }, async (uri, extra) => {
          const out = await r.read({ sessionId: session.id, principal: session.principal, signal: extra.signal, log: li.log });
          return { contents: [{ uri: uri.href, mimeType: out.mimeType ?? r.mimeType, ...(out.blob ? { blob: out.blob } : { text: out.text ?? '' }) }] };
        }));
      } catch (e) { li.log.error(`cannot register resource ${r.uri}: ${String(e)}`); }
    }
    for (const tool of li.instance.tools) {
      const fullName = `${prefix}_${sanitize(tool.name)}`;
      try {
        regs.push(session.mcp.registerTool(fullName, {
          title: tool.title, description: tool.description, inputSchema: (tool.jsonSchema ? z.looseObject({}).meta(tool.jsonSchema) : tool.inputSchema ?? {}) as any, annotations: tool.annotations,
        }, (args: any, extra: any) => this.invoke(session, li, tool, fullName, args, extra)));
      } catch (e) {
        li.log.error(`cannot register tool ${fullName}: ${String(e)}`);
      }
    }
    session.tools.set(li.record.id, regs);
  }

  private async invoke(session: Session, li: LiveInstance, tool: ToolDefinition, fullName: string, args: any, extra: any) {
    const t0 = Date.now();
    session.calls++; session.lastSeen = t0;
    const lvl = this.record.log_level;
    try {
      if (approvals.needsApproval(li.record.approval, tool)) {
        const gate = await approvals.gate({ serverId: this.record.id, instanceId: li.record.id, instanceName: li.record.name, tool: fullName, principal: session.principal, sessionId: session.id, args: args ?? {}, signal: extra.signal });
        if (gate) { if (lvl === 'tools' || lvl === 'full') log({ level: 'info', category: 'tool', serverId: this.record.id, pluginInstanceId: li.record.id, sessionId: session.id, message: `${fullName} by ${session.principal} ${gate.status}` }); return { content: [{ type: 'text', text: gate.message }], isError: true }; }
      }
      const result = await tool.handler(args ?? {}, { sessionId: session.id, principal: session.principal, signal: extra.signal, log: li.log });
      if (lvl === 'tools' || lvl === 'full') {
        log({ level: result.isError ? 'warn' : 'info', category: 'tool', serverId: this.record.id, pluginInstanceId: li.record.id, sessionId: session.id,
          message: `${fullName} by ${session.principal} ${result.isError ? 'ERROR' : 'ok'} ${Date.now() - t0}ms`,
          data: lvl === 'full' ? { args, result: summarize(result) } : undefined });
      }
      return result as any;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (lvl !== 'off') log({ level: 'error', category: 'tool', serverId: this.record.id, pluginInstanceId: li.record.id, sessionId: session.id,
        message: `${fullName} by ${session.principal} THREW ${Date.now() - t0}ms: ${msg}`, data: lvl === 'full' ? { args } : undefined });
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }

  // ---------- status ----------

  async status() {
    const inst = [];
    for (const li of this.live.values()) {
      let st: unknown = undefined;
      try { st = await li.instance.status?.(); } catch (e) { st = { error: String(e) }; }
      inst.push({ id: li.record.id, name: li.record.name, plugin: li.plugin.id, error: li.error, tools: li.instance.tools.map((t) => t.name), toolInfo: li.instance.tools.map((t) => ({ name: t.name, description: t.description })), status: st,
        actions: Object.entries(li.instance.actions ?? {}).map(([k, v]) => ({ key: k, title: v.title })) });
    }
    return {
      id: this.record.id, running: !!this.http, startedAt: this.startedAt, url: `${this.publicUrl}/mcp`, error: this.error,
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, principal: s.principal, client: s.clientInfo, startedAt: s.startedAt, lastSeen: s.lastSeen, calls: s.calls })),
      instances: inst,
    };
  }
}

function summarize(r: any) {
  const content = (r.content ?? []).map((c: any) => c.type === 'text' ? { type: 'text', text: c.text.length > 4000 ? c.text.slice(0, 4000) + '…' : c.text } : { type: c.type, size: (c.data ?? c.blob ?? '').length });
  return { isError: r.isError, content };
}

export { serverStore };
