/**
 * SSH command log and plugin-wide command rules (own tables, like the web plugin's: rule changes apply live
 * without restarting instances or dropping shells).
 *
 * A command line is split into simple commands at ; & | && || newlines ( ) $( and backticks, honouring
 * quotes (single quotes hide everything; double quotes still run $( and backticks). Each simple command's
 * "programs" are its first word plus whatever a wrapper like sudo/env/xargs runs, by basename.
 *   block: any simple command matches a block rule (regex block rules also see the whole line);
 *   allow: every simple command matches an allow rule; otherwise the default policy decides.
 * ponytail: a guardrail, not a sandbox. `sh -c`, eval, interpreters and $VAR programs can run anything, so
 * a block list is advisory; deny-by-default with a narrow allow list (no shells/interpreters) is the real control.
 */
import { getDb } from '../../core/db.js';

export type Kind = 'program' | 'prefix' | 'regex';
export type Action = 'block' | 'allow';
export type Policy = 'allow' | 'deny';
export interface Rule { id: number; action: Action; kind: Kind; value: string; host: string; note: string; created_at: number }
type R = Pick<Rule, 'action' | 'kind' | 'value' | 'host'>;

/** Split a command line into simple commands (see header). */
export function segments(cmd: string): string[] {
  const out: string[] = []; let cur = ''; let q: '' | "'" | '"' = '';
  const cut = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q === "'") { if (c === "'") q = ''; cur += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) { cut(); if (c === '$') i++; continue; }
    if (q === '"') { if (c === '"') q = ''; cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (';&|\n()'.includes(c)) { cut(); continue; }
    cur += c;
  }
  cut();
  return out;
}

/** Wrappers that run the program named after them, with their short flags that take a value. */
const ARG_FLAGS: Record<string, string> = { sudo: 'ughpCDRTUrt', doas: 'uC', env: 'uCSP', nice: 'n', timeout: 'sk', ionice: 'cnp', xargs: 'InPdLsEa', stdbuf: 'ioe', watch: 'nd',
  nohup: '', time: '', exec: 'a', command: '', builtin: '', chroot: '', unbuffer: '' };
const WRAPPERS = new Set(Object.keys(ARG_FLAGS)); // su, sh -c, eval… take a command string: see header
/** Programs a simple command runs: first word (after VAR=x assignments), plus the target of wrappers. */
export function programsOf(seg: string): string[] {
  const words = seg.replace(/["']/g, '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let w: string | undefined; // current wrapper
  let positional = 0;
  for (let i = 0; i < words.length; i++) {
    const x = words[i]!;
    if (!w && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) continue; // assignment before the program
    if (w && x.startsWith('-') && x !== '-') {
      // ponytail: short flags from the table take a value (`-u root`); `--long value` isn't recognised
      if (x.length === 2 && ARG_FLAGS[w]?.includes(x[1]!)) i++;
      continue;
    }
    if (w && positional++ === 0 && ((w === 'timeout' && /^\d/.test(x)) || w === 'chroot' || (w === 'env' && x.includes('=')))) { if (w === 'env') positional = 0; continue; }
    const p = x.replace(/^.*\//, '') || x;
    out.push(p);
    if (!WRAPPERS.has(p)) break;
    w = p; positional = 0;
  }
  return out;
}
export const programs = (cmd: string) => [...new Set(segments(cmd).flatMap(programsOf))];

function matchSeg(r: Pick<Rule, 'kind' | 'value'>, seg: string): boolean {
  if (r.kind === 'program') return programsOf(seg).includes(r.value);
  // whole words: prefix "ls" matches "ls -la" but not "lsblk"
  if (r.kind === 'prefix') return seg.startsWith(r.value) && (seg.length === r.value.length || /\W$/.test(r.value) || /\s/.test(seg[r.value.length]!));
  try { return new RegExp(r.value).test(seg); } catch { return false; }
}
const label = (r: Pick<Rule, 'kind' | 'value' | 'host'>) => `${r.kind}: ${r.value}${r.host ? ` @${r.host}` : ''}`;

/** Block rules always win; then every simple command must be allowed by some allow rule; then the default. */
export function verdict(cmd: string, host: string, list: R[], def: Policy): { blocked?: string; allowedBy?: string } {
  const rs = list.filter((r) => !r.host || r.host === host);
  const segs = segments(cmd);
  const b = rs.find((r) => r.action === 'block' && (segs.some((s) => matchSeg(r, s)) || (r.kind === 'regex' && matchSeg(r, cmd))));
  if (b) return { blocked: label(b) };
  const allows = rs.filter((r) => r.action === 'allow');
  const by = segs.map((s) => allows.find((r) => matchSeg(r, s)));
  if (segs.length && by.every(Boolean)) return { allowedBy: [...new Set(by.map((r) => label(r!)))].join(', ') };
  return def === 'deny' ? { blocked: 'default: deny' } : { allowedBy: 'default: allow' };
}

export function normalize(kind: string, raw: string): { kind: Kind; value: string } {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('value is required');
  if (kind === 'program') { if (/[\s/;&|`$()'"]/.test(v)) throw new Error(`"${v}" is not a program name (no paths, spaces or shell characters)`); return { kind, value: v }; }
  if (kind === 'prefix') return { kind, value: v };
  if (kind === 'regex') { new RegExp(v); return { kind, value: v }; }
  throw new Error(`unknown rule kind "${kind}"`);
}

// ---------------------------------------------------------------- storage

let ready = false;
const db = () => {
  const d = getDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS ssh_commands (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
        host TEXT NOT NULL, tool TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER, error TEXT, blocked TEXT, allowed_by TEXT, ms INTEGER);
      CREATE INDEX IF NOT EXISTS ssh_commands_ts ON ssh_commands(ts);
      CREATE TABLE IF NOT EXISTS ssh_rules (id INTEGER PRIMARY KEY, action TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, host TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value, host));
      CREATE TABLE IF NOT EXISTS ssh_policy (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    ready = true;
  }
  return d;
};
let ruleCache: Rule[] | undefined;
let policyCache: Policy | undefined;
export const rules = () => (ruleCache ??= db().prepare('SELECT * FROM ssh_rules ORDER BY action, kind, value').all() as Rule[]);
export const policy = (): Policy => (policyCache ??= ((db().prepare("SELECT v FROM ssh_policy WHERE k='default'").get() as any)?.v === 'deny' ? 'deny' : 'allow'));
const changed = () => { ruleCache = undefined; policyCache = undefined; };

export interface LogEntry { serverId?: string; instance?: string; principal?: string; host: string; tool: string; command: string; exitCode?: number | null; error?: string; blocked?: string; allowedBy?: string; ms?: number }
export function record(e: LogEntry) {
  db().prepare('INSERT INTO ssh_commands(ts,server_id,instance,principal,host,tool,command,exit_code,error,blocked,allowed_by,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), e.serverId ?? null, e.instance ?? null, e.principal ?? null, e.host, e.tool, e.command, e.exitCode ?? null, e.error ?? null, e.blocked ?? null, e.allowedBy ?? null, e.ms ?? null);
}
export const prune = (days: number) => db().prepare('DELETE FROM ssh_commands WHERE ts < ?').run(Date.now() - days * 86400_000);

const isCmd = (tool: string) => tool === 'exec' || tool === 'shell';
const recent = () => db().prepare("SELECT * FROM ssh_commands WHERE ts >= ? AND tool IN ('exec','shell') ORDER BY ts DESC LIMIT 5000").all(Date.now() - 7 * 86400e3) as any[];

/** Global actions driving the SSH plugin page's Commands panel. */
export const actions = {
  commands: { title: 'Command log', run: async (q: any) => {
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
    for (const r of rows) if (isCmd(r.tool)) { const v = verdict(r.command, r.host, rs, p); r.now_blocked = !!v.blocked; r.programs = programs(r.command); r.single = segments(r.command).length === 1; }
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  } },
  rules: { title: 'Command rules', run: async () => ({ policy: policy(), rules: rules() }) },
  /** What a draft rule would match in the last 7 days, and (for allow) the block rules in its way. */
  preview: { title: 'Preview rule', run: async ({ action, kind, value, host, command }: any) => {
    const r = { action, ...normalize(kind, value), host: String(host ?? '') } as R;
    const rows = recent().filter((x) => !r.host || x.host === r.host);
    const hits = rows.filter((x) => segments(x.command).some((s) => matchSeg(r, s)) || (r.kind === 'regex' && matchSeg(r, x.command)));
    const probes = [...hits.map((x) => [x.command, x.host]), ...(command ? [[String(command), r.host]] : []), ...(r.kind !== 'regex' ? [[r.value, r.host]] : [])] as [string, string][];
    const conflicts = action === 'allow' ? rules().filter((b) => b.action === 'block' && (!b.host || !r.host || b.host === r.host) && probes.some(([c, h]) => verdict(c, h || b.host, [b], 'allow').blocked)) : [];
    return { total: rows.length, hits: hits.length, example: hits[0]?.command, conflicts };
  } },
  /** Add a rule. `remove` = ids of rules to delete first (e.g. blocks in the way of a new allow).
   *  With the default at allow, an allow rule only removes conflicts; it isn't stored (it would do nothing). */
  rule: { title: 'Add rule', run: async ({ action, kind, value, host, note, remove }: any) => {
    if (action !== 'block' && action !== 'allow') throw new Error('action must be block or allow');
    const r = normalize(kind, value);
    const d = db();
    const store = action === 'block' || policy() === 'deny';
    d.transaction(() => {
      for (const id of (Array.isArray(remove) ? remove : [])) d.prepare('DELETE FROM ssh_rules WHERE id=?').run(Number(id));
      if (store) d.prepare('INSERT INTO ssh_rules(action,kind,value,host,note,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,value,host) DO UPDATE SET action=excluded.action, note=excluded.note, created_at=excluded.created_at')
        .run(action, r.kind, r.value, String(host ?? ''), String(note ?? ''), Date.now());
    })();
    changed(); return { ...r, action, stored: store };
  } },
  delete_rule: { title: 'Delete rule', run: async ({ id }: any) => { db().prepare('DELETE FROM ssh_rules WHERE id=?').run(Number(id)); changed(); } },
  /** Programs run in the last 7 days that deny-by-default would stop (and no block rule already does). */
  deny_candidates: { title: 'Programs in use', run: async () => {
    const rs = rules(); const n = new Map<string, number>();
    for (const x of recent()) {
      if (x.blocked) continue;
      for (const s of segments(x.command)) {
        if (verdict(s, x.host, rs, 'deny').blocked !== 'default: deny') continue;
        for (const p of programsOf(s)) n.set(p, (n.get(p) ?? 0) + 1);
      }
    }
    return { programs: [...n].sort((a, b) => b[1] - a[1]) };
  } },
  /** Switch the default policy; `allow` = programs to add as allow rules in the same step. */
  set_policy: { title: 'Set default policy', run: async ({ policy: p, allow }: any) => {
    if (p !== 'allow' && p !== 'deny') throw new Error('policy must be allow or deny');
    const d = db();
    const progs = (Array.isArray(allow) ? allow : []).map((x: string) => normalize('program', x).value);
    d.transaction(() => {
      for (const v of progs) d.prepare("INSERT INTO ssh_rules(action,kind,value,host,note,created_at) VALUES('allow','program',?,'','added when switching to deny',?) ON CONFLICT(kind,value,host) DO NOTHING").run(v, Date.now());
      d.prepare("INSERT INTO ssh_policy(k,v) VALUES('default',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(p);
    })();
    changed(); return { policy: p };
  } },
  clear_commands: { title: 'Clear command log', run: async () => { db().prepare('DELETE FROM ssh_commands').run(); } },
};
