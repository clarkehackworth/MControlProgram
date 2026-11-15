/**
 * Per-tool rules (allow / ask / deny per group + tool, plus a default policy), the tools last seen in each
 * group, and the call log. Own tables like ssh/web: changes apply live, no restarts.
 *
 * `toolRuleStore(db, prefix)` keeps them in `<prefix>_rules` / `_tools` / `_policy` / `_calls`. The MCP pass-through
 * groups by upstream server; other plugins reuse it through mcp's `api` (git groups by repo).
 */
import type { PluginHost, ToolCallContext } from '../../core/plugin-api.js';
import { ask } from '../../core/plugin-api.js';

export type Action = 'allow' | 'ask' | 'deny';
/** Default policy: an action, or `readonly` = allow tools with readOnlyHint, ask for the rest. */
export type Policy = Action | 'readonly';
const ACTIONS = ['allow', 'ask', 'deny'], POLICIES = [...ACTIONS, 'readonly'];

export interface LogEntry { serverId?: string; instance?: string; principal?: string; upstream: string; tool: string; args?: unknown; error?: string; blocked?: string; allowedBy?: string; ms?: number }
export interface SeenTool { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }

/** `defaultPolicy`: the policy a new install starts at. */
export function toolRuleStore(getDb: () => PluginHost['db'], prefix: string, opts: { defaultPolicy?: Policy } = {}) {
  const T = (t: string) => `${prefix}_${t}`;
  let ready = false;
  const db = () => {
    const d = getDb();
    if (!ready) {
      const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(T('policy'));
      d.exec(`CREATE TABLE IF NOT EXISTS ${T('calls')} (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
          upstream TEXT NOT NULL, tool TEXT NOT NULL, args TEXT, error TEXT, blocked TEXT, allowed_by TEXT, ms INTEGER);
        CREATE INDEX IF NOT EXISTS ${T('calls_ts')} ON ${T('calls')}(ts);
        CREATE TABLE IF NOT EXISTS ${T('rules')} (upstream TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY(upstream, tool));
        CREATE TABLE IF NOT EXISTS ${T('tools')} (upstream TEXT NOT NULL, tool TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(upstream, tool));
        CREATE TABLE IF NOT EXISTS ${T('policy')} (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
      // New installs start at the default policy; existing ones without a stored policy keep the old implicit allow.
      if (fresh) d.prepare(`INSERT INTO ${T('policy')}(k,v) VALUES('default',?)`).run(opts.defaultPolicy ?? 'ask');
      ready = true;
    }
    return d;
  };

  let ruleCache: Map<string, Action> | undefined;
  let policyCache: Policy | undefined;
  const key = (upstream: string, tool: string) => `${upstream}\0${tool}`;
  const rules = () => (ruleCache ??= new Map((db().prepare(`SELECT * FROM ${T('rules')}`).all() as any[]).map((r) => [key(r.upstream, r.tool), r.action])));
  const policy = (): Policy => (policyCache ??= (((v) => POLICIES.includes(v) ? v : 'allow')((db().prepare(`SELECT v FROM ${T('policy')} WHERE k='default'`).get() as any)?.v) as Policy));
  const changed = () => { ruleCache = undefined; policyCache = undefined; };

  /** The tool's own rule, else the default policy (`readOnly` = the tool's readOnlyHint, for the readonly policy). */
  function verdict(upstream: string, tool: string, readOnly: boolean): { action: Action; by: string } {
    const r = rules().get(key(upstream, tool));
    if (r) return { action: r, by: `tool rule: ${r}` };
    const p = policy();
    if (p === 'readonly') return readOnly ? { action: 'allow', by: 'default: read-only allowed' } : { action: 'ask', by: 'default: ask (not read-only)' };
    return { action: p, by: `default: ${p}` };
  }

  /** Replace what is known about a group's tools (called whenever its tool list is fetched). */
  function seen(upstream: string, tools: SeenTool[]) {
    const d = db();
    d.transaction(() => {
      d.prepare(`DELETE FROM ${T('tools')} WHERE upstream=?`).run(upstream);
      for (const t of tools) d.prepare(`INSERT OR REPLACE INTO ${T('tools')}(upstream,tool,description,read_only) VALUES(?,?,?,?)`).run(upstream, t.name, t.description ?? '', t.annotations?.readOnlyHint ? 1 : 0);
    })();
  }
  /** Group renamed in the inventory: its rules and tool list follow. The log keeps the old name: it's history. */
  function renameUpstream(from: string, to: string) {
    const d = db();
    for (const t of [T('rules'), T('tools')]) { d.prepare(`UPDATE OR IGNORE ${t} SET upstream=? WHERE upstream=?`).run(to, from); d.prepare(`DELETE FROM ${t} WHERE upstream=?`).run(from); }
    changed();
  }

  function record(e: LogEntry) {
    const args = e.args === undefined ? null : JSON.stringify(e.args);
    db().prepare(`INSERT INTO ${T('calls')}(ts,server_id,instance,principal,upstream,tool,args,error,blocked,allowed_by,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Date.now(), e.serverId ?? null, e.instance ?? null, e.principal ?? null, e.upstream, e.tool, args && args.length > 4000 ? args.slice(0, 4000) + '…' : args, e.error ?? null, e.blocked ?? null, e.allowedBy ?? null, e.ms ?? null);
  }

  /**
   * Check `checks` (default: `entry.tool`) against the rules: any deny throws, any ask waits for a human, else allowed.
   * One call asks once, whatever it touches (an approval is consumed by one execution). Refusals are logged.
   * `feature` / `summary` / `subject` go to the ask; `entry` to the log. Returns who allowed it.
   */
  async function gate(call: Pick<ToolCallContext, 'ask'>, entry: LogEntry, readOnly: boolean, a: { feature: string; summary: string; subject: unknown },
    checks: { tool: string; readOnly: boolean }[] = [{ tool: entry.tool, readOnly }]): Promise<string> {
    const vs = checks.map((c) => ({ ...verdict(entry.upstream, c.tool, c.readOnly), tool: c.tool }));
    const worst = (x: Action) => vs.filter((v) => v.action === x).map((v) => (checks.length > 1 ? `${v.tool}: ${v.by}` : v.by)).join('; ');
    const v = worst('deny') ? { action: 'deny', by: worst('deny') } : worst('ask') ? { action: 'ask', by: worst('ask') } : { action: 'allow', by: worst('allow') };
    const rec = (blocked: string) => { try { record({ ...entry, blocked }); } catch { /* the refusal still stands */ } };
    if (v.action === 'deny') { rec(v.by); throw new Error(`${entry.upstream}/${vs.filter((x) => x.action === 'deny').map((x) => x.tool).join(', ')} is disabled by the administrator. Tell the user if you need it.`); }
    if (v.action === 'allow') return v.by;
    try { return await ask(call, { ...a, reason: v.by }); }
    catch (e) { rec(`awaiting approval: ${v.by}`); throw e; }
  }

  /** Global actions driving the rules panel and call log. */
  const actions = {
    tool_rules: { hidden: true, title: 'Tool rules', run: async () => ({
      policy: policy(),
      tools: (db().prepare(`SELECT * FROM ${T('tools')} ORDER BY upstream, tool`).all() as any[]).map((t) => ({ ...t, read_only: !!t.read_only, rule: rules().get(key(t.upstream, t.tool)) ?? null })),
    }) },
    /** `action` null/'' = follow the default policy. */
    set_tool_rule: { hidden: true, title: 'Set tool rule', run: async ({ upstream, tool, action }: any) => {
      if (!upstream || !tool) throw new Error('upstream and tool are required');
      if (action && !ACTIONS.includes(action)) throw new Error('action must be allow, ask or deny');
      if (action) db().prepare(`INSERT INTO ${T('rules')}(upstream,tool,action) VALUES(?,?,?) ON CONFLICT(upstream,tool) DO UPDATE SET action=excluded.action`).run(String(upstream), String(tool), action);
      else db().prepare(`DELETE FROM ${T('rules')} WHERE upstream=? AND tool=?`).run(String(upstream), String(tool));
      changed();
    } },
    set_policy: { hidden: true, title: 'Set default policy', run: async ({ policy: p }: any) => {
      if (!POLICIES.includes(p)) throw new Error('policy must be allow, readonly, ask or deny');
      db().prepare(`INSERT INTO ${T('policy')}(k,v) VALUES('default',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(p);
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
      const rows = db().prepare(`SELECT * FROM ${T('calls')} WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1) as any[];
      const ro = new Set((db().prepare(`SELECT upstream, tool FROM ${T('tools')} WHERE read_only=1`).all() as any[]).map((t) => key(t.upstream, t.tool)));
      for (const r of rows) r.now = verdict(r.upstream, r.tool, ro.has(key(r.upstream, r.tool))).action;
      return { rows: rows.slice(0, limit), more: rows.length > limit };
    } },
    clear_calls: { hidden: true, title: 'Clear call log', run: async () => { db().prepare(`DELETE FROM ${T('calls')}`).run(); } },
  };

  return { verdict, seen, renameUpstream, record, gate, policy, actions };
}
export type ToolRuleStore = ReturnType<typeof toolRuleStore>;
