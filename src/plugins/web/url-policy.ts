/**
 * URL access rules. The web plugin enforces its own list; other plugins get the same engine through
 * web's `api` (declare `dependencies: { web }`) and keep their own list in their own tables.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { safeRegex } from '../../core/plugin-api.js';

export type BlockKind = 'domain' | 'url' | 'regex';
export type RuleAction = 'block' | 'ask' | 'allow';
export type Policy = 'allow' | 'ask' | 'deny';
export type Verdict = { blocked?: string; ask?: string; allowedBy?: string };
const ACTIONS = ['block', 'ask', 'allow'], POLICIES = ['allow', 'ask', 'deny'];
export interface Rule { id: number; action: RuleAction; kind: BlockKind; value: string; note: string; created_at: number }

/** "evil.com." names the same host as evil.com. */
export const canonicalHost = (h: string) => h.toLowerCase().replace(/\.+$/, '');

export const label = (r: Pick<Rule, 'kind' | 'value'>) => `${r.kind}: ${r.value}`;
/** Domain = host or any subdomain; URL = prefix; regex = case-insensitive on the full URL. */
export function ruleMatches(r: Pick<Rule, 'kind' | 'value'>, u: URL): boolean {
  const host = canonicalHost(u.hostname);
  if (r.kind === 'domain') return host === r.value || host.endsWith('.' + r.value);
  if (r.kind === 'url') return u.href.startsWith(r.value);
  try { return safeRegex(r.value, 'i').test(u.href); } catch { return false; }
}
/** Block rules always win, then ask rules, then allow rules, then the default policy. `ask` = needs a human (approvals). */
export function verdict(u: URL, list: Pick<Rule, 'action' | 'kind' | 'value'>[], def: Policy): Verdict {
  const b = list.find((r) => r.action === 'block' && ruleMatches(r, u));
  if (b) return { blocked: label(b) };
  const q = list.find((r) => r.action === 'ask' && ruleMatches(r, u));
  if (q) return { ask: label(q) };
  const a = list.find((r) => r.action === 'allow' && ruleMatches(r, u));
  if (a) return { allowedBy: label(a) };
  return def === 'deny' ? { blocked: 'default: deny' } : def === 'ask' ? { ask: 'default: ask' } : { allowedBy: 'default: allow' };
}

/** Features JS RegExp has and Chrome's RE2 (declarativeNetRequest regexFilter) does not. */
const NOT_RE2 = /\(\?<?[=!]|\\[1-9]|\\k</;

/** `re2`: the rule will run in the browser, so reject lookaround/backreferences up front. */
export function normalizeBlock(kind: string, raw: string, opts: { re2?: boolean } = {}): { kind: BlockKind; value: string } {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('value is required');
  if (kind === 'domain') {
    const d = canonicalHost((/^[a-z]+:\/\//i.test(v) ? new URL(v).hostname : v.split('/')[0]!).replace(/^\*?\./, ''));
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(d)) throw new Error(`"${v}" is not a domain`);
    return { kind, value: d };
  }
  if (kind === 'url') {
    const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`); // throws on garbage
    u.hostname = canonicalHost(u.hostname);
    return { kind, value: u.href };
  }
  if (kind === 'regex') {
    safeRegex(v, 'i');
    if (opts.re2 && NOT_RE2.test(v)) throw new Error("the browser's regex engine (RE2) does not support lookahead/lookbehind or backreferences");
    return { kind, value: v };
  }
  throw new Error(`unknown block kind "${kind}"`);
}

/**
 * A persisted rule list + default policy, with the admin actions the rules UI calls.
 * Tables: `<prefix>_blocks`, `<prefix>_policy` (keys `default` and `rev`; rev bumps on every change).
 */
export function ruleStore(getDb: () => BetterSqlite3.Database, prefix: string, opts: { re2?: boolean } = {}) {
  const T = `${prefix}_blocks`, P = `${prefix}_policy`;
  let ready = false;
  const db = () => {
    const d = getDb();
    if (!ready) {
      const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(P);
      d.exec(`CREATE TABLE IF NOT EXISTS ${T} (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value));
        CREATE TABLE IF NOT EXISTS ${P} (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
      // New installs start at ask; existing ones without a stored policy keep the old implicit allow.
      if (fresh) d.prepare(`INSERT INTO ${P}(k,v) VALUES('default','ask')`).run();
      try { d.exec(`ALTER TABLE ${T} ADD COLUMN action TEXT NOT NULL DEFAULT 'block'`); } catch { /* exists */ }
      ready = true;
    }
    return d;
  };
  let ruleCache: Rule[] | undefined;
  let policyCache: Policy | undefined;
  const listeners = new Set<() => void>();
  const rules = () => (ruleCache ??= db().prepare(`SELECT * FROM ${T} ORDER BY action, kind, value`).all() as Rule[]);
  const policy = (): Policy => (policyCache ??= (((v) => POLICIES.includes(v) ? v : 'allow')((db().prepare(`SELECT v FROM ${P} WHERE k='default'`).get() as any)?.v) as Policy));
  const rev = (): number => Number((db().prepare(`SELECT v FROM ${P} WHERE k='rev'`).get() as any)?.v ?? 0);
  const changed = () => {
    db().prepare(`INSERT INTO ${P}(k,v) VALUES('rev','1') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1`).run();
    ruleCache = undefined; policyCache = undefined;
    for (const f of listeners) f();
  };

  /** Current verdict for a logged URL, for "now blocked / now asks" in request logs. */
  const now = (url: string, def: Policy = policy()) => {
    let u: URL; try { u = new URL(url.replace(/^ws/i, 'http')); } catch { return { blocked: true, ask: false, by: 'invalid url' }; }
    const v = verdict(u, rules(), def);
    return { blocked: !!v.blocked, ask: !!v.ask, by: v.blocked ?? v.ask ?? v.allowedBy ?? '' };
  };
  const OVERRIDES: Record<string, string[]> = { allow: ['block', 'ask'], ask: ['block'], block: [] };

  const actions = {
    /**
     * Verdicts for the rules UI, so it never re-implements matching. `urls` → `now` (under `policy` if given);
     * `rule` (a draft {kind, value}) → which of `urls` it matches, and with `action`, the ids of stored rules that
     * would override it on those URLs, the draft's own URL/domain and `probes`; `error` if the draft is invalid.
     */
    check: { hidden: true, title: 'Check URLs', run: async ({ urls, policy: p, rule, action, probes }: Record<string, any>) => {
      const list: string[] = Array.isArray(urls) ? urls.map(String) : [];
      const out: { now: ReturnType<typeof now>[]; matches?: boolean[]; conflicts?: number[]; error?: string } =
        { now: list.map((u) => now(u, POLICIES.includes(p) ? p : policy())) };
      if (!rule?.value) return out;
      let draft: { kind: BlockKind; value: string };
      try { draft = normalizeBlock(rule.kind, rule.value, opts); } catch (e) { return { ...out, error: (e as Error).message }; }
      const parse = (u: string) => { try { return new URL(u); } catch { return undefined; } };
      out.matches = list.map((u) => { const x = parse(u); return !!x && ruleMatches(draft, x); });
      const own = draft.kind === 'url' ? [draft.value] : draft.kind === 'domain' ? [`https://${draft.value}/`] : [];
      const pr = [...list.filter((_, i) => out.matches![i]), ...own, ...(Array.isArray(probes) ? probes.map(String) : [])].map(parse).filter((x): x is URL => !!x);
      out.conflicts = rules().filter((r) => OVERRIDES[action]?.includes(r.action) && pr.some((x) => ruleMatches(r, x))).map((r) => r.id);
      return out;
    } },
    rules: { hidden: true, title: 'Access rules', run: async () => ({ policy: policy(), rules: rules(), rev: rev() }) },
    /** Add a rule. `remove` = ids of rules to delete first (e.g. blocks/asks that would override a new allow).
     *  With the default policy at allow, an allow rule only removes conflicts; it isn't stored (it would do nothing). */
    rule: { hidden: true, title: 'Add rule', run: async ({ action, kind, value, note, remove }: Record<string, any>) => {
      if (!ACTIONS.includes(action)) throw new Error('action must be block, ask or allow');
      const r = normalizeBlock(kind, value, opts);
      const d = db();
      const store = action !== 'allow' || policy() !== 'allow';
      d.transaction(() => {
        for (const id of (Array.isArray(remove) ? remove : [])) d.prepare(`DELETE FROM ${T} WHERE id=?`).run(Number(id));
        if (store) d.prepare(`INSERT INTO ${T}(action,kind,value,note,created_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,value) DO UPDATE SET action=excluded.action, note=excluded.note, created_at=excluded.created_at`)
          .run(action, r.kind, r.value, String(note ?? ''), Date.now());
      })();
      changed(); return { ...r, action, stored: store };
    } },
    delete_rule: { hidden: true, title: 'Delete rule', run: async ({ id }: Record<string, any>) => { db().prepare(`DELETE FROM ${T} WHERE id=?`).run(Number(id)); changed(); } },
    /** Switch the default policy; `allow` = domains to add as allow rules in the same step (so switching to ask/deny doesn't break current traffic). */
    set_policy: { hidden: true, title: 'Set default policy', run: async ({ policy: p, allow }: Record<string, any>) => {
      if (!POLICIES.includes(p)) throw new Error('policy must be allow, ask or deny');
      const d = db();
      const doms = (Array.isArray(allow) ? allow : []).map((x: string) => normalizeBlock('domain', x).value);
      d.transaction(() => {
        for (const v of doms) d.prepare(`INSERT INTO ${T}(action,kind,value,note,created_at) VALUES('allow','domain',?,'added when switching default',?) ON CONFLICT(kind,value) DO NOTHING`).run(v, Date.now());
        d.prepare(`INSERT INTO ${P}(k,v) VALUES('default',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(p);
      })();
      changed(); return { policy: p };
    } },
  };
  return { rules, policy, rev, now, actions, onChange: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); } };
}
export type RuleStore = ReturnType<typeof ruleStore>;
