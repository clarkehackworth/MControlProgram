/** Thin repository layer over SQLite. */
import { randomUUID } from 'node:crypto';
import { getDb, type Row } from './db.js';
import { hashPassword, randomToken, sha256 } from './crypto.js';
import { encryptSecrets, mergeSecrets, redactSecrets, decryptSecrets } from './secrets.js';
import { plugins } from './plugin-loader.js';
import type { ServerLogLevel } from './logger.js';

export type AuthMode = 'none' | 'bearer' | 'oauth' | 'both';

export interface ServerRecord {
  id: string; name: string; description: string; host: string; port: number; enabled: boolean;
  auth_mode: AuthMode; log_level: ServerLogLevel; public_url: string | null; instructions: string;
  created_at: string; updated_at: string;
}
export interface PluginInstanceRecord {
  id: string; server_id: string; plugin_id: string; name: string; enabled: boolean;
  config: Record<string, any>; position: number; created_at: string; updated_at: string;
  approval: ApprovalPolicy;
}

export type ToolRule = 'allow' | 'ask' | 'deny';
/**
 * Per-instance tool gate. `rules` (short tool name → allow/ask/deny) win; other tools follow `mode`:
 * none = allow, writes = ask unless read-only, all = ask.
 */
export interface ApprovalPolicy { mode: 'none' | 'writes' | 'all'; rules?: Record<string, ToolRule> }

/** Older rows stored `{ mode: 'list', tools: [...] }`: those tools ask, the rest are allowed. */
export function normalizeApproval(a: any): ApprovalPolicy {
  if (a?.mode === 'list') return { mode: 'none', rules: { ...Object.fromEntries((a.tools ?? []).map((t: string) => [t, 'ask'])), ...a.rules } };
  return { mode: a?.mode === 'writes' || a?.mode === 'all' ? a.mode : 'none', rules: a?.rules ?? {} };
}

const bool = (v: any) => !!v;
const rowToServer = (r: Row): ServerRecord => ({ ...r, enabled: bool(r.enabled) } as ServerRecord);
const rowToInstance = (r: Row): PluginInstanceRecord => ({ ...r, enabled: bool(r.enabled), config: JSON.parse(r.config), approval: normalizeApproval(JSON.parse(r.approval || '{}')) } as PluginInstanceRecord);

export const servers = {
  list: (): ServerRecord[] => (getDb().prepare('SELECT * FROM servers ORDER BY port').all() as Row[]).map(rowToServer),
  get: (id: string): ServerRecord | undefined => {
    const r = getDb().prepare('SELECT * FROM servers WHERE id=?').get(id) as Row | undefined;
    return r && rowToServer(r);
  },
  create(input: Partial<ServerRecord> & { name: string; port: number }): ServerRecord {
    const id = randomUUID();
    getDb().prepare(`INSERT INTO servers(id,name,description,host,port,enabled,auth_mode,log_level,public_url,instructions)
      VALUES(@id,@name,@description,@host,@port,@enabled,@auth_mode,@log_level,@public_url,@instructions)`).run({
      id, name: input.name, description: input.description ?? '', host: input.host ?? '127.0.0.1', port: input.port,
      enabled: input.enabled === false ? 0 : 1, auth_mode: input.auth_mode ?? 'bearer', log_level: input.log_level ?? 'tools',
      public_url: input.public_url ?? null, instructions: input.instructions ?? '',
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<ServerRecord>): ServerRecord {
    const cur = this.get(id);
    if (!cur) throw new Error('server not found');
    const next = { ...cur, ...patch };
    getDb().prepare(`UPDATE servers SET name=@name,description=@description,host=@host,port=@port,enabled=@enabled,
      auth_mode=@auth_mode,log_level=@log_level,public_url=@public_url,instructions=@instructions,updated_at=datetime('now') WHERE id=@id`)
      .run({ ...next, enabled: next.enabled ? 1 : 0, public_url: next.public_url || null });
    return this.get(id)!;
  },
  delete: (id: string) => getDb().prepare('DELETE FROM servers WHERE id=?').run(id),
};

export const instances = {
  /** Every loaded plugin is attached to every server (enabled); admins can disable per server. Returns the newly created ids. */
  ensureAll(serverId: string): string[] {
    const have = new Set(this.listForServer(serverId).map((i) => i.plugin_id));
    return plugins.list().filter((p) => !have.has(p.id)).map((p) => this.create(serverId, p.id, p.id, {}).id);
  },
  listForServer: (serverId: string): PluginInstanceRecord[] =>
    (getDb().prepare('SELECT * FROM plugin_instances WHERE server_id=? ORDER BY position, created_at').all(serverId) as Row[]).map(rowToInstance),
  get: (id: string): PluginInstanceRecord | undefined => {
    const r = getDb().prepare('SELECT * FROM plugin_instances WHERE id=?').get(id) as Row | undefined;
    return r && rowToInstance(r);
  },
  /** Stored config has secrets encrypted. */
  create(serverId: string, pluginId: string, name: string, cfg: Record<string, any>, approval?: ApprovalPolicy): PluginInstanceRecord {
    const p = plugins.get(pluginId);
    if (!p) throw new Error(`unknown plugin ${pluginId}`);
    if (this.listForServer(serverId).some((i) => i.name === name)) throw new Error(`an instance named "${name}" already exists on this server`);
    const id = randomUUID();
    const pos = (getDb().prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM plugin_instances WHERE server_id=?').get(serverId) as Row).p;
    getDb().prepare('INSERT INTO plugin_instances(id,server_id,plugin_id,name,config,position,approval) VALUES(?,?,?,?,?,?,?)')
      .run(id, serverId, pluginId, name, JSON.stringify(encryptSecrets({ ...(p.defaultConfig ?? {}), ...cfg }, p.configSchema)), pos, JSON.stringify(approval ?? { mode: 'none' }));
    return this.get(id)!;
  },
  update(id: string, patch: { name?: string; enabled?: boolean; config?: Record<string, any>; position?: number; approval?: ApprovalPolicy }): PluginInstanceRecord {
    const cur = this.get(id);
    if (!cur) throw new Error('plugin instance not found');
    if (patch.name && patch.name !== cur.name && this.listForServer(cur.server_id).some((i) => i.name === patch.name)) throw new Error(`an instance named "${patch.name}" already exists on this server`);
    const p = plugins.get(cur.plugin_id);
    let config = cur.config;
    if (patch.config && p) config = encryptSecrets(mergeSecrets(patch.config, cur.config, p.configSchema), p.configSchema) as Record<string, any>;
    getDb().prepare(`UPDATE plugin_instances SET name=?,enabled=?,config=?,position=?,approval=?,updated_at=datetime('now') WHERE id=?`)
      .run(patch.name ?? cur.name, (patch.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(config), patch.position ?? cur.position, JSON.stringify(patch.approval ?? cur.approval), id);
    return this.get(id)!;
  },
  delete: (id: string) => getDb().prepare('DELETE FROM plugin_instances WHERE id=?').run(id),
  /** Config for the UI (secrets redacted). */
  redacted(inst: PluginInstanceRecord) {
    const p = plugins.get(inst.plugin_id);
    return p ? redactSecrets(inst.config, p.configSchema) : {};
  },
  /** Config for runtime (secrets decrypted). */
  decrypted(inst: PluginInstanceRecord): Record<string, any> {
    const p = plugins.get(inst.plugin_id);
    // Defaults are layered under stored config so instances created before a plugin added a key still get it.
    return p ? { ...(p.defaultConfig ?? {}), ...(decryptSecrets(inst.config, p.configSchema) as Record<string, any>) } : inst.config;
  },
};

/** Plugin-wide config (one row per plugin id). Secrets encrypted per the plugin's globalConfigSchema. */
export const pluginConfig = {
  raw(pluginId: string): Record<string, any> {
    const r = getDb().prepare('SELECT config FROM plugin_config WHERE plugin_id=?').get(pluginId) as Row | undefined;
    return r ? JSON.parse(r.config) : {};
  },
  schema: (pluginId: string) => plugins.get(pluginId)?.globalConfigSchema ?? { type: 'object', properties: {} },
  decrypted(pluginId: string): Record<string, any> {
    const p = plugins.get(pluginId);
    return { ...(p?.defaultGlobalConfig ?? {}), ...(decryptSecrets(this.raw(pluginId), this.schema(pluginId)) as Record<string, any>) };
  },
  redacted: (pluginId: string) => redactSecrets({ ...(plugins.get(pluginId)?.defaultGlobalConfig ?? {}), ...pluginConfig.raw(pluginId) }, pluginConfig.schema(pluginId)),
  /** From the UI: placeholders are merged with stored secrets. */
  saveFromUi(pluginId: string, incoming: Record<string, any>) {
    const schema = this.schema(pluginId);
    this.saveRaw(pluginId, encryptSecrets(mergeSecrets(incoming, this.raw(pluginId), schema), schema) as Record<string, any>);
  },
  /** From plugin code: plaintext in, encrypted at rest. */
  savePlain(pluginId: string, cfg: Record<string, any>) {
    this.saveRaw(pluginId, encryptSecrets(cfg, this.schema(pluginId)) as Record<string, any>);
  },
  saveRaw(pluginId: string, cfg: Record<string, any>) {
    getDb().prepare(`INSERT INTO plugin_config(plugin_id,config) VALUES(?,?) ON CONFLICT(plugin_id) DO UPDATE SET config=excluded.config, updated_at=datetime('now')`).run(pluginId, JSON.stringify(cfg));
  },
};

export const bearerTokens = {
  list: (serverId: string) =>
    getDb().prepare('SELECT id,name,prefix,created_at,last_used_at,expires_at FROM bearer_tokens WHERE server_id=? ORDER BY created_at').all(serverId) as Row[],
  /** Returns the plaintext token exactly once. */
  create(serverId: string, name: string, expiresAt?: string) {
    // names become the principal that scopes per-agent state, so they must be unique per server
    if (this.list(serverId).some((t) => t.name === name)) throw new Error(`a token named "${name}" already exists`);
    const token = 'gdn_' + randomToken(32);
    const id = randomUUID();
    getDb().prepare('INSERT INTO bearer_tokens(id,server_id,name,token_hash,prefix,expires_at) VALUES(?,?,?,?,?,?)')
      .run(id, serverId, name, sha256(token), token.slice(0, 10), expiresAt ?? null);
    return { id, token };
  },
  verify(serverId: string, token: string): { id: string; name: string } | undefined {
    const r = getDb().prepare(`SELECT id,name,expires_at FROM bearer_tokens WHERE server_id=? AND token_hash=?`).get(serverId, sha256(token)) as Row | undefined;
    if (!r) return;
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return;
    getDb().prepare(`UPDATE bearer_tokens SET last_used_at=datetime('now') WHERE id=?`).run(r.id);
    return { id: r.id, name: r.name };
  },
  delete: (id: string) => getDb().prepare('DELETE FROM bearer_tokens WHERE id=?').run(id),
};

export const admins = {
  count: () => (getDb().prepare('SELECT COUNT(*) AS c FROM admins').get() as Row).c as number,
  get: (username: string) => getDb().prepare('SELECT * FROM admins WHERE username=?').get(username) as Row | undefined,
  create: (username: string, password: string) =>
    getDb().prepare('INSERT INTO admins(username,password_hash) VALUES(?,?)').run(username, hashPassword(password)),
  setPassword: (id: number, password: string) =>
    getDb().prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(password), id),
  createSession(adminId: number, ttlMs = 7 * 86400e3) {
    const id = randomToken(32);
    getDb().prepare('INSERT INTO admin_sessions(id,admin_id,expires_at) VALUES(?,?,?)').run(id, adminId, Date.now() + ttlMs);
    return id;
  },
  sessionUser(sessionId: string): Row | undefined {
    const r = getDb().prepare(`SELECT a.id, a.username FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id=? AND s.expires_at>?`)
      .get(sessionId, Date.now()) as Row | undefined;
    return r;
  },
  deleteOtherSessions: (adminId: number, keep?: string) => getDb().prepare('DELETE FROM admin_sessions WHERE admin_id=? AND id<>?').run(adminId, keep ?? ''),
  deleteSession: (id: string) => getDb().prepare('DELETE FROM admin_sessions WHERE id=?').run(id),
  pruneSessions: () => getDb().prepare('DELETE FROM admin_sessions WHERE expires_at<?').run(Date.now()),
};

export const logs = {
  query(q: { serverId?: string; category?: string; level?: string; search?: string; before?: number; limit?: number }) {
    const where: string[] = []; const args: any[] = [];
    if (q.serverId) { where.push('server_id=?'); args.push(q.serverId); }
    if (q.category) { where.push('(category=? OR category LIKE ?)'); args.push(q.category, `${q.category}:%`); }
    if (q.level) { where.push('level=?'); args.push(q.level); }
    if (q.search) { where.push('(message LIKE ? OR data LIKE ?)'); args.push(`%${q.search}%`, `%${q.search}%`); }
    if (q.before) { where.push('id<?'); args.push(q.before); }
    const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return getDb().prepare(sql).all(...args, Math.min(q.limit ?? 200, 1000)) as Row[];
  },
  clear: (serverId?: string) => serverId ? getDb().prepare('DELETE FROM logs WHERE server_id=?').run(serverId) : getDb().prepare('DELETE FROM logs').run(),
};

/**
 * Inventory renames: an item that keeps its position in its array but changes `name` (to a name not already used) is a rename.
 * Rewrites every reference by name: instance fields with `x-options-from` (and their `x-disabled-key` lists), and string fields
 * in any plugin's global config pointing at it (`"<key>"` from the same plugin, `"<pluginId>:<key>"` from others).
 * Returns the renames found (`key` → old → new) so plugins can update their own tables; touched plugin/instance ids for restarts.
 */
export function propagateRenames(pluginId: string, before: Record<string, any>, after: Record<string, any>) {
  const found: { key: string; from: string; to: string }[] = [];
  for (const k of Object.keys(pluginConfig.schema(pluginId).properties ?? {})) {
    const a = before[k], b = after[k];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) continue; // ponytail: add/delete + rename in one save isn't detected
    const an = a.map((x) => x?.name), bn = b.map((x) => x?.name);
    an.forEach((from, i) => { const to = bn[i]; if (typeof from === 'string' && typeof to === 'string' && from !== to && !bn.includes(from) && !an.includes(to)) found.push({ key: k, from, to }); });
  }
  const touchedPlugins = new Set<string>(), touchedInstances: { id: string; server: string }[] = [];
  if (!found.length) return { renames: found, touchedPlugins, touchedInstances };
  /** Rewrite `obj` (config shaped by `schema`); `ref(src)` = the rename map for an `x-options-from` source, if it points at us. */
  const rewrite = (obj: any, schema: any, ref: (src: string) => Map<string, string> | undefined): boolean => {
    let hit = false;
    if (!obj || typeof obj !== 'object' || !schema) return false;
    if (Array.isArray(obj)) { for (const v of obj) hit = rewrite(v, schema.items, ref) || hit; return hit; }
    for (const [f, fs] of Object.entries<any>(schema.properties ?? {})) {
      const m = ref(fs['x-options-from'] ?? fs.items?.['x-options-from'] ?? '');
      if (m && typeof obj[f] === 'string' && m.has(obj[f])) { obj[f] = m.get(obj[f]); hit = true; }
      else if (m && Array.isArray(obj[f])) {
        for (const lk of [f, fs['x-disabled-key']].filter(Boolean)) if (Array.isArray(obj[lk]) && obj[lk].some((n: string) => m.has(n))) { obj[lk] = obj[lk].map((n: string) => m.get(n) ?? n); hit = true; }
      } else if (typeof obj[f] === 'object') hit = rewrite(obj[f], fs, ref) || hit;
    }
    return hit;
  };
  const mapFor = (fromPlugin: string) => (src: string) => {
    const [pid, key] = src.includes(':') ? src.split(':') as [string, string] : [fromPlugin, src];
    if (pid !== pluginId) return undefined;
    const m = new Map(found.filter((r) => r.key === key).map((r) => [r.from, r.to] as const));
    return m.size ? m : undefined;
  };
  // the plugin's own config: `after` is what is about to be saved, so rewrite it in place
  if (rewrite(after, pluginConfig.schema(pluginId), mapFor(pluginId))) touchedPlugins.add(pluginId);
  for (const p of plugins.list()) {
    if (p.id !== pluginId) {
      const g = pluginConfig.raw(p.id);
      if (rewrite(g, p.globalConfigSchema, mapFor(p.id))) { pluginConfig.saveRaw(p.id, g); touchedPlugins.add(p.id); }
    }
  }
  for (const r of getDb().prepare('SELECT id, server_id, plugin_id, config FROM plugin_instances').all() as Row[]) {
    const p = plugins.get(r.plugin_id); const c = JSON.parse(r.config);
    if (p && rewrite(c, p.configSchema, mapFor(p.id))) {
      getDb().prepare("UPDATE plugin_instances SET config=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(c), r.id);
      touchedInstances.push({ id: r.id, server: r.server_id });
    }
  }
  return { renames: found, touchedPlugins, touchedInstances };
}

