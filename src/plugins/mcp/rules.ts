/**
 * MCP pass-through tool rules (allow / ask / deny per upstream server + tool, plus a default policy), the
 * tools last seen on each upstream, and the call log. Own tables like ssh/web: changes apply live, no restarts.
 */
import type { PluginHost } from '../../core/plugin-api.js';

let getDb: () => PluginHost['db'];
export const init = (h: PluginHost) => { getDb = () => h.db; ready = false; };

export type Action = 'allow' | 'ask' | 'deny';
/** Default policy: an action, or `readonly` = allow tools with readOnlyHint, ask for the rest. */
export type Policy = Action | 'readonly';
const ACTIONS = ['allow', 'ask', 'deny'], POLICIES = [...ACTIONS, 'readonly'];

let ready = false;
const db = () => {
  const d = getDb();
  if (!ready) {
    const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_policy'").get();
    d.exec(`CREATE TABLE IF NOT EXISTS mcp_calls (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
        upstream TEXT NOT NULL, tool TEXT NOT NULL, args TEXT, error TEXT, blocked TEXT, allowed_by TEXT, ms INTEGER);
      CREATE INDEX IF NOT EXISTS mcp_calls_ts ON mcp_calls(ts);
      CREATE TABLE IF NOT EXISTS mcp_rules (upstream TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY(upstream, tool));
      CREATE TABLE IF NOT EXISTS mcp_tools (upstream TEXT NOT NULL, tool TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(upstream, tool));
      CREATE TABLE IF NOT EXISTS mcp_policy (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    // New installs start at ask; existing ones without a stored policy keep the old implicit allow.
    if (fresh) d.prepare("INSERT INTO mcp_policy(k,v) VALUES('default','ask')").run();
    ready = true;
  }
  return d;
};

let ruleCache: Map<string, Action> | undefined;
let policyCache: Policy | undefined;
const key = (upstream: string, tool: string) => `${upstream}\0${tool}`;
const rules = () => (ruleCache ??= new Map((db().prepare('SELECT * FROM mcp_rules').all() as any[]).map((r) => [key(r.upstream, r.tool), r.action])));
export const policy = (): Policy => (policyCache ??= (((v) => POLICIES.includes(v) ? v : 'allow')((db().prepare("SELECT v FROM mcp_policy WHERE k='default'").get() as any)?.v) as Policy));
const changed = () => { ruleCache = undefined; policyCache = undefined; };

/** The tool's own rule, else the default policy (`readOnly` = the tool's readOnlyHint, for the readonly policy). */
export function verdict(upstream: string, tool: string, readOnly: boolean): { action: Action; by: string } {
  const r = rules().get(key(upstream, tool));
  if (r) return { action: r, by: `tool rule: ${r}` };
  const p = policy();
  if (p === 'readonly') return readOnly ? { action: 'allow', by: 'default: read-only allowed' } : { action: 'ask', by: 'default: ask (not read-only)' };
  return { action: p, by: `default: ${p}` };
}

/** Replace what is known about an upstream's tools (called whenever its tool list is fetched). */
export function seen(upstream: string, tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[]) {
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM mcp_tools WHERE upstream=?').run(upstream);
    for (const t of tools) d.prepare('INSERT OR REPLACE INTO mcp_tools(upstream,tool,description,read_only) VALUES(?,?,?,?)').run(upstream, t.name, t.description ?? '', t.annotations?.readOnlyHint ? 1 : 0);
  })();
}
/** Upstream renamed in the inventory: its rules and tool list follow. The log keeps the old name: it's history. */
export function renameUpstream(from: string, to: string) {
  const d = db();
  for (const t of ['mcp_rules', 'mcp_tools']) { d.prepare(`UPDATE OR IGNORE ${t} SET upstream=? WHERE upstream=?`).run(to, from); d.prepare(`DELETE FROM ${t} WHERE upstream=?`).run(from); }
  changed();
}

export interface LogEntry { serverId?: string; instance?: string; principal?: string; upstream: string; tool: string; args?: unknown; error?: string; blocked?: string; allowedBy?: string; ms?: number }
export function record(e: LogEntry) {
  const args = e.args === undefined ? null : JSON.stringify(e.args);
  db().prepare('INSERT INTO mcp_calls(ts,server_id,instance,principal,upstream,tool,args,error,blocked,allowed_by,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), e.serverId ?? null, e.instance ?? null, e.principal ?? null, e.upstream, e.tool, args && args.length > 4000 ? args.slice(0, 4000) + '…' : args, e.error ?? null, e.blocked ?? null, e.allowedBy ?? null, e.ms ?? null);
}

/** Global actions driving the MCP plugin page. */
export const actions = {
  tool_rules: { hidden: true, title: 'Tool rules', run: async () => ({
    policy: policy(),
    tools: (db().prepare('SELECT * FROM mcp_tools ORDER BY upstream, tool').all() as any[]).map((t) => ({ ...t, read_only: !!t.read_only, rule: rules().get(key(t.upstream, t.tool)) ?? null })),
  }) },
  /** `action` null/'' = follow the default policy. */
  set_tool_rule: { hidden: true, title: 'Set tool rule', run: async ({ upstream, tool, action }: any) => {
    if (!upstream || !tool) throw new Error('upstream and tool are required');
    if (action && !ACTIONS.includes(action)) throw new Error('action must be allow, ask or deny');
    if (action) db().prepare('INSERT INTO mcp_rules(upstream,tool,action) VALUES(?,?,?) ON CONFLICT(upstream,tool) DO UPDATE SET action=excluded.action').run(String(upstream), String(tool), action);
    else db().prepare('DELETE FROM mcp_rules WHERE upstream=? AND tool=?').run(String(upstream), String(tool));
    changed();
  } },
  set_policy: { hidden: true, title: 'Set default policy', run: async ({ policy: p }: any) => {
    if (!POLICIES.includes(p)) throw new Error('policy must be allow, readonly, ask or deny');
    db().prepare("INSERT INTO mcp_policy(k,v) VALUES('default',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(p);
    changed(); return { policy: p };
  } },
  calls: { hidden: true, title: 'Call log', run: async (q: any) => {
    const where = ['ts >= ?', 'ts <= ?']; const args: any[] = [Number(q.since) || 0, Number(q.until) || Date.now()];
    if (q.q) { where.push('(tool LIKE ? OR args LIKE ? OR principal LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
    if (q.upstream) { where.push('upstream = ?'); args.push(q.upstream); }
    if (q.server) { where.push('server_id = ?'); args.push(q.server); }
    if (q.outcome === 'blocked') where.push('blocked IS NOT NULL');
    if (q.outcome === 'allowed') where.push('blocked IS NULL');
    if (q.outcome === 'error') where.push('blocked IS NULL AND error IS NOT NULL');
    const limit = Math.min(Number(q.limit) || 500, 5000);
    const rows = db().prepare(`SELECT * FROM mcp_calls WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1) as any[];
    const ro = new Set((db().prepare('SELECT upstream, tool FROM mcp_tools WHERE read_only=1').all() as any[]).map((t) => key(t.upstream, t.tool)));
    for (const r of rows) r.now = verdict(r.upstream, r.tool, ro.has(key(r.upstream, r.tool))).action;
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  } },
  clear_calls: { hidden: true, title: 'Clear call log', run: async () => { db().prepare('DELETE FROM mcp_calls').run(); } },
};
