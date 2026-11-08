/**
 * SSH command log and plugin-wide command rules (own tables, like the web plugin's: rule changes apply live
 * without restarting instances or dropping shells).
 *
 * Command lines are parsed by shell-parse.ts into every command they run (including through pipes, lists,
 * substitutions, wrappers like sudo/xargs/find -exec, and sh -c / ssh host "…" strings) plus output-redirect targets.
 *   block: any command, written file, or (regex) the whole line matches a block rule;
 *   ask:   otherwise, the same for an ask rule: a human approves the line (approvals);
 *   allow: under deny-by-default every command and written file must match an allow rule, and the line must be
 *   fully analyzable (no program names or scripts built from $VARs / $( ), no shell reading stdin, no syntax errors).
 * ponytail: a guardrail, not a sandbox. Interpreters (python -c, perl -e, node…) and scripts on disk run code that
 * isn't checked, so a block list is advisory; deny-by-default with a narrow allow list is the real control.
 */
import { safeRegex, type PluginHost } from '../../core/plugin-api.js';

let getDb: () => PluginHost['db'];
export const init = (h: PluginHost) => { getDb = () => h.db; ready = false; };

import { analyze, type Analysis, type Cmd } from './shell-parse.js';

export type Kind = 'program' | 'prefix' | 'regex' | 'write';
export type Action = 'block' | 'ask' | 'allow';
export type Policy = 'allow' | 'ask' | 'deny';
const ACTIONS = ['block', 'ask', 'allow'], POLICIES = ['allow', 'ask', 'deny'];
export interface Rule { id: number; action: Action; kind: Kind; value: string; host: string; note: string; created_at: number }
type R = Pick<Rule, 'action' | 'kind' | 'value' | 'host'>;

const cache = new Map<string, Analysis>();
/** Parsed command line, memoised (log listings re-check thousands of rows). */
export function parse(line: string): Analysis {
  let a = cache.get(line);
  if (!a) { a = analyze(line); if (cache.size > 2000) cache.clear(); cache.set(line, a); }
  return a;
}
export const programs = (line: string) => [...new Set(parse(line).commands.map((c) => c.program))];

/** Names a program rule can hold. A broken line (e.g. `\'` inside single quotes) can make bash run a "program" named after a chunk of code. */
const BAD_PROGRAM = /[\s/;&|`$()'"]/;
const ruleable = (p: string) => !!p && !BAD_PROGRAM.test(p);

function matchCmd(r: Pick<Rule, 'kind' | 'value'>, c: Cmd): boolean {
  if (r.kind === 'program') return c.program === r.value;
  // whole words: prefix "ls" matches "ls -la" but not "lsblk"
  if (r.kind === 'prefix') return c.text.startsWith(r.value) && (c.text.length === r.value.length || /\W$/.test(r.value) || /\s/.test(c.text[r.value.length]!));
  if (r.kind === 'regex') try { return safeRegex(r.value).test(c.text); } catch { return false; }
  return false;
}
/** write rules are path prefixes by whole components: "/tmp" covers /tmp and /tmp/x, not /tmpfoo. */
const matchWrite = (r: Pick<Rule, 'kind' | 'value'>, f: string) => r.kind === 'write' && (f === r.value || f.startsWith(r.value.endsWith('/') ? r.value : r.value + '/'));
const matchLine = (r: Pick<Rule, 'kind' | 'value'>, line: string, a: Analysis) =>
  a.commands.some((c) => matchCmd(r, c)) || a.writes.some((f) => matchWrite(r, f)) || (r.kind === 'regex' && (() => { try { return safeRegex(r.value).test(line); } catch { return false; } })());
const label = (r: Pick<Rule, 'kind' | 'value' | 'host'>) => `${r.kind}: ${r.value}${r.host ? ` @${r.host}` : ''}`;

/** Block rules always win, then ask rules; then every command and written file must be allowed (and nothing unanalyzable); then the default. */
export function verdict(line: string, host: string, list: R[], def: Policy): { blocked?: string; ask?: string; allowedBy?: string } {
  const rs = list.filter((r) => !r.host || r.host === host);
  const a = parse(line);
  const b = rs.find((r) => r.action === 'block' && matchLine(r, line, a));
  if (b) return { blocked: label(b) };
  const q = rs.find((r) => r.action === 'ask' && matchLine(r, line, a));
  if (q) return { ask: label(q) };
  const allows = rs.filter((r) => r.action === 'allow');
  const by = [...a.commands.map((c) => allows.find((r) => matchCmd(r, c))), ...a.writes.map((f) => allows.find((r) => matchWrite(r, f)))];
  if (!a.unknown.length && by.every(Boolean)) return { allowedBy: by.length ? [...new Set(by.map((r) => label(r!)))].join(', ') : 'nothing to run' };
  if (def === 'allow') return { allowedBy: 'default: allow' };
  // a human reading the line can judge what the parser can't
  if (def === 'ask') return { ask: a.unknown.length ? `default: ask (cannot check: ${a.unknown[0]})` : 'default: ask' };
  return { blocked: a.unknown.length ? `cannot check: ${a.unknown[0]}` : 'default: deny' };
}

export function normalize(kind: string, raw: string): { kind: Kind; value: string } {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('value is required');
  if (kind === 'program') { if (!ruleable(v)) throw new Error(`"${v}" is not a program name (no paths, spaces or shell characters)`); return { kind, value: v }; }
  if (kind === 'prefix') return { kind, value: v };
  if (kind === 'regex') { safeRegex(v); return { kind, value: v }; }
  if (kind === 'write') return { kind, value: v.length > 1 ? v.replace(/\/+$/, '') : v };
  throw new Error(`unknown rule kind "${kind}"`);
}

// ---------------------------------------------------------------- storage

let ready = false;
const db = () => {
  const d = getDb();
  if (!ready) {
    const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ssh_policy'").get();
    d.exec(`CREATE TABLE IF NOT EXISTS ssh_commands (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
        host TEXT NOT NULL, tool TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER, error TEXT, blocked TEXT, allowed_by TEXT, ms INTEGER);
      CREATE INDEX IF NOT EXISTS ssh_commands_ts ON ssh_commands(ts);
      CREATE TABLE IF NOT EXISTS ssh_rules (id INTEGER PRIMARY KEY, action TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, host TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value, host));
      CREATE TABLE IF NOT EXISTS ssh_policy (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    // New installs start at ask; existing ones without a stored policy keep the old implicit allow.
    if (fresh) d.prepare("INSERT INTO ssh_policy(k,v) VALUES('default','ask')").run();
    ready = true;
  }
  return d;
};
/** Host-scoped rules follow a host rename (a clashing rule already on the new name wins). The log keeps the old name: it's history. */
export function renameHost(from: string, to: string) { db().prepare('UPDATE OR IGNORE ssh_rules SET host=? WHERE host=?').run(to, from); db().prepare('DELETE FROM ssh_rules WHERE host=?').run(from); changed(); }
let ruleCache: Rule[] | undefined;
let policyCache: Policy | undefined;
export const rules = () => (ruleCache ??= db().prepare('SELECT * FROM ssh_rules ORDER BY action, kind, value').all() as Rule[]);
export const policy = (): Policy => (policyCache ??= (((v) => POLICIES.includes(v) ? v : 'allow')((db().prepare("SELECT v FROM ssh_policy WHERE k='default'").get() as any)?.v) as Policy));
const changed = () => { ruleCache = undefined; policyCache = undefined; };

export interface LogEntry { serverId?: string; instance?: string; principal?: string; host: string; tool: string; command: string; exitCode?: number | null; error?: string; blocked?: string; allowedBy?: string; ms?: number }
export function record(e: LogEntry) {
  db().prepare('INSERT INTO ssh_commands(ts,server_id,instance,principal,host,tool,command,exit_code,error,blocked,allowed_by,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), e.serverId ?? null, e.instance ?? null, e.principal ?? null, e.host, e.tool, e.command, e.exitCode ?? null, e.error ?? null, e.blocked ?? null, e.allowedBy ?? null, e.ms ?? null);
}
export const prune = (days: number) => db().prepare('DELETE FROM ssh_commands WHERE ts < ?').run(Date.now() - days * 86400_000);

/** What the UI needs to offer rules for a line (programs, single command, written files), so it needs no copy of the parser. */
export function describe(line: string) {
  const a = parse(line);
  // only names a program rule can hold; for the rest the UI offers the command (prefix) instead
  return { programs: programs(line).filter(ruleable), writes: [...new Set(a.writes)], unknown: a.unknown, single: a.commands.length === 1 ? a.commands[0]!.text : undefined };
}

const isCmd = (tool: string) => tool === 'exec' || tool === 'shell';
const recent = () => db().prepare("SELECT * FROM ssh_commands WHERE ts >= ? AND tool IN ('exec','shell') ORDER BY ts DESC LIMIT 5000").all(Date.now() - 7 * 86400e3) as any[];

/** Global actions driving the SSH plugin page's Commands panel. */
export const actions = {
  commands: { hidden: true, title: 'Command log', run: async (q: any) => {
    const where = ['ts >= ?', 'ts <= ?']; const args: any[] = [Number(q.since) || 0, Number(q.until) || Date.now()];
    if (q.q) { where.push('(command LIKE ? OR principal LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
    if (q.host) { where.push('host = ?'); args.push(q.host); }
    if (q.tool) { where.push(q.tool === 'sftp' ? "tool LIKE 'sftp%'" : 'tool = ?'); if (q.tool !== 'sftp') args.push(q.tool); }
    if (q.server) { where.push('server_id = ?'); args.push(q.server); }
    if (q.outcome === 'blocked') where.push('blocked IS NOT NULL');
    if (q.outcome === 'allowed') where.push('blocked IS NULL');
    if (q.outcome === 'error') where.push('blocked IS NULL AND (error IS NOT NULL OR exit_code != 0)');
    const limit = Math.min(Number(q.limit) || 500, 5000);
    const rows = db().prepare(`SELECT * FROM ssh_commands WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1) as any[];
    const rs = rules(); const p = policy();
    // what the current rules would say, and the programs, so the page needs no copy of the parser
    for (const r of rows) if (isCmd(r.tool)) { const v = verdict(r.command, r.host, rs, p); r.now_blocked = !!v.blocked; r.now_ask = !!v.ask; Object.assign(r, describe(r.command)); }
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  } },
  rules: { hidden: true, title: 'Command rules', run: async () => ({ policy: policy(), rules: rules() }) },
  /** Why a line isn't allowed outright: overriding block/ask rules, written files no allow rule covers, parts the parser can't check. */
  explain: { hidden: true, title: 'Explain verdict', run: async ({ command, host }: any) => {
    const line = String(command ?? ''), h = String(host ?? ''), a = parse(line);
    const rs = rules().filter((r) => !r.host || r.host === h);
    const allows = rs.filter((r) => r.action === 'allow');
    return {
      verdict: verdict(line, h, rules(), policy()),
      overriding: rs.filter((r) => r.action !== 'allow' && matchLine(r, line, a)),
      writes: [...new Set(a.writes)].filter((f) => !allows.some((r) => matchWrite(r, f))),
      unknown: a.unknown,
    };
  } },
  /** What a draft rule would match in the last 7 days, and (for allow) the block rules in its way. */
  preview: { hidden: true, title: 'Preview rule', run: async ({ action, kind, value, host, command }: any) => {
    const r = { action, ...normalize(kind, value), host: String(host ?? '') } as R;
    const rows = recent().filter((x) => !r.host || x.host === r.host);
    const hits = rows.filter((x) => matchLine(r, x.command, parse(x.command)));
    const probes = [...hits.map((x) => [x.command, x.host]), ...(command ? [[String(command), r.host]] : []), ...(r.kind === 'write' ? [[`true > '${r.value.replace(/'/g, `'\\''`)}'`, r.host]] : r.kind !== 'regex' ? [[r.value, r.host]] : [])] as [string, string][];
    // rules that override the draft: blocks override asks and allows, asks override allows
    const over = action === 'allow' ? ['block', 'ask'] : action === 'ask' ? ['block'] : [];
    const conflicts = rules().filter((b) => over.includes(b.action) && (!b.host || !r.host || b.host === r.host) && probes.some(([c, h]) => { const v = verdict(c, h || b.host, [b], 'allow'); return v.blocked || v.ask; }));
    return { total: rows.length, hits: hits.length, example: hits[0]?.command, conflicts };
  } },
  /** Add a rule. `remove` = ids of rules to delete first (e.g. blocks in the way of a new allow).
   *  With the default at allow, an allow rule only removes conflicts; it isn't stored (it would do nothing). */
  rule: { hidden: true, title: 'Add rule', run: async ({ action, kind, value, host, note, remove }: any) => {
    if (!ACTIONS.includes(action)) throw new Error('action must be block, ask or allow');
    const r = normalize(kind, value);
    const d = db();
    const store = action !== 'allow' || policy() !== 'allow';
    d.transaction(() => {
      for (const id of (Array.isArray(remove) ? remove : [])) d.prepare('DELETE FROM ssh_rules WHERE id=?').run(Number(id));
      if (store) d.prepare('INSERT INTO ssh_rules(action,kind,value,host,note,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,value,host) DO UPDATE SET action=excluded.action, note=excluded.note, created_at=excluded.created_at')
        .run(action, r.kind, r.value, String(host ?? ''), String(note ?? ''), Date.now());
    })();
    changed(); return { ...r, action, stored: store };
  } },
  delete_rule: { hidden: true, title: 'Delete rule', run: async ({ id }: any) => { db().prepare('DELETE FROM ssh_rules WHERE id=?').run(Number(id)); changed(); } },
  /** Programs run in the last 7 days that deny-by-default would stop (and no block rule already does). */
  deny_candidates: { hidden: true, title: 'Programs in use', run: async () => {
    const rs = rules(); const n = new Map<string, number>();
    for (const x of recent()) {
      if (x.blocked) continue;
      const mine = rs.filter((r) => !r.host || r.host === x.host);
      for (const c of parse(x.command).commands)
        if (ruleable(c.program) && !mine.some((r) => matchCmd(r, c))) n.set(c.program, (n.get(c.program) ?? 0) + 1);
    }
    return { programs: [...n].sort((a, b) => b[1] - a[1]) };
  } },
  /** Switch the default policy; `allow` = programs to add as allow rules in the same step. */
  set_policy: { hidden: true, title: 'Set default policy', run: async ({ policy: p, allow }: any) => {
    if (!POLICIES.includes(p)) throw new Error('policy must be allow, ask or deny');
    const d = db();
    const progs = (Array.isArray(allow) ? allow : []).map((x: string) => normalize('program', x).value);
    d.transaction(() => {
      for (const v of progs) d.prepare("INSERT INTO ssh_rules(action,kind,value,host,note,created_at) VALUES('allow','program',?,'','added when switching default',?) ON CONFLICT(kind,value,host) DO NOTHING").run(v, Date.now());
      d.prepare("INSERT INTO ssh_policy(k,v) VALUES('default',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(p);
    })();
    changed(); return { policy: p };
  } },
  clear_commands: { hidden: true, title: 'Clear command log', run: async () => { db().prepare('DELETE FROM ssh_commands').run(); } },
};
