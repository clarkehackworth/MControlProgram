/** Admin REST API consumed by the web UI. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { servers, instances, bearerTokens, admins, logs, pluginConfig, propagateRenames } from '../core/store.js';
import { approvals } from '../core/approvals.js';
import { plugins, loadPlugins, depResolver } from '../core/plugin-loader.js';
import { manager } from '../mcp/manager.js';
import { oauthClients } from '../mcp/oauth.js';
import { throttle } from '../core/http-guard.js';
import { hashPassword, verifyPassword } from '../core/crypto.js';
import { SERVER_LOG_LEVELS, ScopedLogger, log, onLog } from '../core/logger.js';
import { setting } from '../core/db.js';
import { getGlobalConfig, setGlobalConfig, GLOBAL_DEFAULTS } from '../core/global-config.js';

const DUMMY_HASH = hashPassword('dummy-for-constant-time');
const COOKIE = 'mcontrolprogram_session';

// package.json is the single version source; `npm run redeploy` bumps it.
const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const sid = req.cookies?.[COOKIE];
  const user = sid ? admins.sessionUser(sid) : undefined;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  (req as any).admin = user;
  next();
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try { const out = await fn(req, res); if (!res.headersSent) res.json(out ?? { ok: true }); }
  catch (e) { const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message; res.status(400).json({ error: msg }); }
};

export function adminApi() {
  const r = Router();

  // ---- first-run setup (only while no admin exists) ----
  r.get('/setup', wrap(() => ({ needed: admins.count() === 0 })));
  r.post('/setup', wrap((req, res) => {
    if (admins.count() > 0) throw new Error('setup already completed');
    const { username, password } = z.object({ username: z.string().min(1).max(64), password: z.string().min(8) }).parse(req.body);
    admins.create(username, password);
    const sid = admins.createSession(admins.get(username)!.id);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 86400e3 });
    log({ level: 'info', category: 'auth', message: `initial admin "${username}" created via setup` });
    return { username };
  }));

  // ---- auth ----
  r.post('/auth/login', wrap((req, res) => {
    const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    if (throttle.blocked(req)) { res.status(429).json({ error: 'too many failed logins; try again later' }); return; }
    const a = admins.get(username);
    // verify even for unknown users so response time doesn't reveal which usernames exist
    if (!verifyPassword(password, a?.password_hash ?? DUMMY_HASH) || !a) { throttle.fail(req); log({ level: 'warn', category: 'auth', message: `admin login failed for ${username}` }); res.status(401).json({ error: 'invalid credentials' }); return; }
    throttle.ok(req);
    const sid = admins.createSession(a.id);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 86400e3 });
    log({ level: 'info', category: 'auth', message: `admin ${username} logged in` });
    return { username };
  }));
  r.post('/auth/logout', (req, res) => { if (req.cookies?.[COOKIE]) admins.deleteSession(req.cookies[COOKIE]); res.clearCookie(COOKIE); res.json({ ok: true }); });
  r.get('/auth/me', (req, res) => { const u = req.cookies?.[COOKIE] ? admins.sessionUser(req.cookies[COOKIE]) : undefined; res.json(u ? { username: u.username } : null); });

  r.use(requireAdmin);

  r.post('/auth/password', wrap((req) => {
    const { current, next } = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
    const a = admins.get((req as any).admin.username)!;
    if (!verifyPassword(current, a.password_hash)) throw new Error('current password incorrect');
    admins.setPassword(a.id, next);
    admins.deleteOtherSessions(a.id, req.cookies?.[COOKIE]);
  }));

  // ---- plugins ----
  const pluginView = (p: ReturnType<typeof plugins.list>[number]) => ({
    id: p.id, name: p.name, version: p.version, description: p.description, source: p.source,
    configSchema: p.configSchema, defaultConfig: p.defaultConfig ?? {},
    globalConfigSchema: p.globalConfigSchema, globalConfig: p.globalConfigSchema ? pluginConfig.redacted(p.id) : undefined,
    globalActions: Object.entries(p.globalActions ?? {}).filter(([, a]) => !a.hidden).map(([key, a]) => ({ key, title: a.title, inventory: a.inventory, when: a.when })),
    dependencies: p.dependencies ?? {}, optionalDependencies: p.optionalDependencies ?? {},
    ui: !!plugins.uiFile(p.id),
  });
  /** First string that violates its schema `pattern` (walks objects and arrays); the UI checks the same thing live. */
  const patternViolation = (schema: any, value: any, where = ''): string | undefined => {
    if (!schema) return undefined;
    if (schema.type === 'object' && value && typeof value === 'object') for (const [k, s] of Object.entries<any>(schema.properties ?? {})) { const e = patternViolation(s, value[k], where ? `${where}.${k}` : k); if (e) return e; }
    if (schema.type === 'array' && Array.isArray(value)) for (const [i, v] of value.entries()) { const e = patternViolation(schema.items, v, `${where}[${i}]`); if (e) return e; }
    if (schema.pattern && typeof value === 'string' && value !== '' && !new RegExp(schema.pattern).test(value)) return `${schema.title ?? where}: "${value}" must match ${schema.pattern}${schema['x-pattern-hint'] ? ` (${schema['x-pattern-hint']})` : ''}`;
    return undefined;
  };
  r.get('/plugins', wrap(() => plugins.list().map(pluginView)));
  r.put('/plugins/:pid/config', wrap(async (req) => {
    const pid = req.params.pid as string; const p = plugins.get(pid);
    if (!p?.globalConfigSchema) throw new Error('plugin has no global config');
    const body = z.record(z.string(), z.any()).parse(req.body);
    const bad = patternViolation(p.globalConfigSchema, body); if (bad) throw new Error(bad);
    const { renames, touchedPlugins, touchedInstances } = propagateRenames(pid, pluginConfig.raw(pid), body);
    pluginConfig.saveFromUi(pid, body);
    for (const r of renames) p.onRenamed?.(r.key, r.from, r.to);
    for (const id of new Set([pid, ...touchedPlugins])) await manager.applyPlugin(id);
    for (const i of touchedInstances) await manager.applyInstance(i.id, i.server);
    return pluginView(p);
  }));
  r.post('/plugins/:pid/actions/:action', wrap(async (req) => {
    const pid = req.params.pid as string; const p = plugins.get(pid);
    const action = p?.globalActions?.[req.params.action as string];
    if (!action) throw new Error('unknown plugin action');
    const result = await action.run(req.body ?? {}, {
      config: pluginConfig.decrypted(pid),
      async setConfig(next) { pluginConfig.savePlain(pid, next); await manager.applyPlugin(pid); },
      log: new ScopedLogger({ category: `plugin:${pid}` }),
      dep: depResolver(p!),
    });
    return { result };
  }));
  // OAuth redirect target for plugins that act as OAuth clients (e.g. mcp): runs the plugin's `callback` action with the query params.
  // The plugin's admin UI: an ES module the web app imports at runtime (see web/src/plugin-ui.ts).
  r.get('/plugins/:pid/ui.js', (req, res) => {
    const f = plugins.uiFile(req.params.pid as string);
    if (!f) { res.status(404).json({ error: 'no ui' }); return; }
    res.set('Cache-Control', 'no-cache').type('text/javascript').sendFile(f);
  });
  r.get('/plugins/:pid/callback', async (req, res) => {
    const pid = req.params.pid as string; const p = plugins.get(pid);
    const action = p?.globalActions?.callback;
    if (!action) return res.status(404).send('no callback');
    try {
      await action.run(req.query as Record<string, any>, { config: pluginConfig.decrypted(pid), async setConfig(next) { pluginConfig.savePlain(pid, next); await manager.applyPlugin(pid); }, log: new ScopedLogger({ category: `plugin:${pid}` }), dep: depResolver(p!) });
      res.send('<p>Authorized. You can close this tab and return to MControlProgram.</p>');
    } catch (e) { res.status(400).send(`<p>Authorization failed: ${String((e as Error).message ?? e)}</p>`); }
  });
  r.post('/plugins/reload', wrap(async () => {
    const out = await loadPlugins();
    for (const rs of manager.all()) for (const id of [...rs.live.keys()]) await rs.reloadInstance(id);
    return out;
  }));
  r.get('/plugins/npm', wrap(() => JSON.parse(setting.get('npmPlugins') ?? '[]')));
  r.put('/plugins/npm', wrap((req) => { setting.set('npmPlugins', JSON.stringify(z.array(z.string()).parse(req.body))); }));

  // ---- servers ----
  const serverSchema = z.object({
    name: z.string().min(1), description: z.string().optional(), host: z.string().min(1).optional(), port: z.number().int().min(1).max(65535),
    enabled: z.boolean().optional(), auth_mode: z.enum(['none', 'bearer', 'oauth', 'both']).optional(),
    log_level: z.enum(SERVER_LOG_LEVELS as [string, ...string[]]).optional(), public_url: z.string().url().or(z.literal('')).nullable().optional(), instructions: z.string().optional(),
  });
  const serverView = async (id: string) => {
    const rec = servers.get(id); if (!rec) throw new Error('server not found');
    const rs = manager.get(id);
    for (const iid of instances.ensureAll(id)) await manager.applyInstance(iid, id);
    return { ...rec, status: rs ? await rs.status() : { running: false, error: manager.lastError(id), sessions: [], instances: [] },
      instances: instances.listForServer(id).map((i) => ({ ...i, config: instances.redacted(i) })) };
  };
  r.get('/servers', wrap(async () => Promise.all(servers.list().map((s) => serverView(s.id)))));
  r.post('/servers', wrap(async (req) => { const rec = servers.create(serverSchema.parse(req.body) as any); await manager.apply(rec.id).catch(() => {}); return serverView(rec.id); }));
  r.get('/servers/:id', wrap((req) => serverView(req.params.id as string)));
  r.put('/servers/:id', wrap(async (req) => { const id = req.params.id as string; servers.update(id, serverSchema.partial().parse(req.body) as any); await manager.apply(id).catch(() => {}); return serverView(id); }));
  r.delete('/servers/:id', wrap(async (req) => { const id = req.params.id as string; await manager.stop(id); approvals.cancelFor({ serverId: id }); servers.delete(id); }));
  r.post('/servers/:id/start', wrap(async (req) => { const id = req.params.id as string; servers.update(id, { enabled: true }); await manager.start(id); return serverView(id); }));
  r.post('/servers/:id/stop', wrap(async (req) => { const id = req.params.id as string; servers.update(id, { enabled: false }); await manager.stop(id); return serverView(id); }));
  r.post('/servers/:id/restart', wrap(async (req) => { const id = req.params.id as string; await manager.stop(id); await manager.start(id); return serverView(id); }));
  r.delete('/servers/:id/sessions/:sid', wrap(async (req) => { await manager.get(req.params.id as string)?.closeSession(req.params.sid as string, 'closed by admin'); }));

  const toolRule = z.enum(['allow', 'ask', 'deny']);
  const approvalSchema = z.object({ mode: z.enum(['none', 'writes', 'all']), rules: z.record(z.string(), toolRule).optional() });
  // ---- approvals (human-in-the-loop gate) ----
  r.get('/approvals', wrap((req) => { const plugin = typeof req.query.plugin === 'string' ? req.query.plugin : undefined; return { pending: approvals.list('pending', { plugin }), recent: approvals.list('decided', { limit: 50, plugin }) }; }));
  // "Add allow/block rule" for the core tool gate. Applied live (the gate re-reads it per call): no instance reload.
  r.put('/instances/:iid/tool-rules/:tool', wrap((req) => {
    const inst = instances.get(req.params.iid as string); if (!inst) throw new Error('not found');
    const rule = z.object({ rule: toolRule.nullable() }).parse(req.body).rule;
    const rules = { ...inst.approval.rules };
    if (rule) rules[req.params.tool as string] = rule; else delete rules[req.params.tool as string];
    return instances.update(inst.id, { approval: { ...inst.approval, rules } }).approval;
  }));
  r.post('/approvals/:id/reopen', wrap((req) => approvals.reopen(req.params.id as string, (req as any).admin?.username ?? 'admin')));
  r.post('/approvals/:id/:decision', wrap((req) => {
    const d = z.enum(['approved', 'denied']).parse(req.params.decision);
    return approvals.decide(req.params.id as string, d, (req as any).admin?.username ?? 'admin');
  }));
  // ---- plugin instances ----
  r.post('/servers/:id/instances', wrap(async (req) => {
    const { plugin_id, name, config, approval } = z.object({ plugin_id: z.string(), name: z.string().regex(/^[a-zA-Z0-9_-]+$/), config: z.record(z.string(), z.any()).optional(), approval: approvalSchema.optional() }).parse(req.body);
    const sid = req.params.id as string;
    if (!servers.get(sid)) throw new Error('server not found');
    const inst = instances.create(sid, plugin_id, name, config ?? {}, approval);
    await manager.applyInstance(inst.id, sid);
    return serverView(sid);
  }));
  r.put('/instances/:iid', wrap(async (req) => {
    const patch = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.any()).optional(), position: z.number().int().optional(), approval: approvalSchema.optional() }).parse(req.body);
    const inst = instances.update(req.params.iid as string, patch);
    // approval is read live per call; changing only it must not drop shells / cookie jars
    if (Object.keys(patch).some((k) => k !== 'approval')) await manager.applyInstance(inst.id, inst.server_id);
    return serverView(inst.server_id);
  }));
  r.delete('/instances/:iid', wrap(async (req) => {
    const inst = instances.get(req.params.iid as string); if (!inst) throw new Error('not found');
    instances.delete(inst.id);
    approvals.cancelFor({ instanceId: inst.id });
    await manager.applyInstance(inst.id, inst.server_id);
    return serverView(inst.server_id);
  }));
  r.post('/instances/:iid/actions/:action', wrap(async (req) => {
    const inst = instances.get(req.params.iid as string); if (!inst) throw new Error('not found');
    const li = manager.get(inst.server_id)?.live.get(inst.id);
    const action = li?.instance.actions?.[req.params.action as string];
    if (!action) throw new Error('action unavailable (is the server running?)');
    return { result: await action.run(req.body ?? {}) };
  }));

  // ---- access: bearer tokens & oauth clients ----
  r.get('/servers/:id/tokens', wrap((req) => bearerTokens.list(req.params.id as string)));
  r.post('/servers/:id/tokens', wrap((req) => {
    const { name, expires_at } = z.object({ name: z.string().min(1), expires_at: z.string().optional() }).parse(req.body);
    const t = bearerTokens.create(req.params.id as string, name, expires_at);
    log({ level: 'info', category: 'auth', serverId: req.params.id as string, message: `bearer token "${name}" created by ${(req as any).admin.username}` });
    return t; // plaintext token returned once
  }));
  r.delete('/tokens/:tid', wrap((req) => { bearerTokens.delete(req.params.tid as string); }));
  r.get('/servers/:id/oauth/clients', wrap((req) => oauthClients.list(req.params.id as string)));
  r.put('/oauth/clients/:cid', wrap((req) => { oauthClients.setApproved(req.params.cid as string, z.object({ approved: z.boolean() }).parse(req.body).approved); }));
  r.delete('/oauth/clients/:cid', wrap((req) => { oauthClients.delete(req.params.cid as string); }));
  r.get('/servers/:id/oauth/tokens', wrap((req) => oauthClients.tokens(req.params.id as string)));

  // ---- logs ----
  r.get('/logs', wrap((req) => logs.query({
    serverId: req.query.server as string | undefined, category: req.query.category as string | undefined, level: req.query.level as string | undefined,
    search: req.query.q as string | undefined, before: req.query.before ? Number(req.query.before) : undefined, limit: req.query.limit ? Number(req.query.limit) : undefined,
  })));
  r.delete('/logs', wrap((req) => { logs.clear(req.query.server as string | undefined); }));
  r.get('/logs/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }).flushHeaders();
    const server = req.query.server as string | undefined;
    const off = onLog((e) => { if (!server || e.serverId === server) res.write(`data: ${JSON.stringify(e)}\n\n`); });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { off(); clearInterval(ping); });
  });

  // ---- system ----
  r.get('/system', wrap(() => ({ version: VERSION, uptime: process.uptime(), node: process.version, dataDir: process.env.MCONTROLPROGRAM_DATA_DIR ?? 'data',
    servers: manager.all().length, plugins: plugins.list().length, global: getGlobalConfig(), globalDefaults: GLOBAL_DEFAULTS })));
  r.put('/system', wrap((req) => {
    setGlobalConfig(z.object({ stateIdleSec: z.number().int().min(60).optional(), connectionIdleSec: z.number().int().min(10).optional(), logRetentionDays: z.number().int().min(1).optional(),
      approvalWaitSec: z.number().int().min(1).max(600).optional(), approvalMaxAttempts: z.number().int().min(1).optional(), approvalTtlSec: z.number().int().min(60).optional() }).parse(req.body));
    return getGlobalConfig();
  }));

  return r;
}
