/**
 * URL access rules shared by the web plugin (enforced here) and the browserpaw plugin (pushed to the
 * BrowserPaw extension and enforced there with declarativeNetRequest). Each plugin has its own list.
 */
import { safeRegex } from './safe-regex.js';
import { getDb } from './db.js';

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
export function ruleStore(prefix: 'web' | 'browserpaw', opts: { re2?: boolean } = {}) {
  const T = `${prefix}_blocks`, P = `${prefix}_policy`;
  let ready = false;
  const db = () => {
    const d = getDb();
    if (!ready) {
      d.exec(`CREATE TABLE IF NOT EXISTS ${T} (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value));
        CREATE TABLE IF NOT EXISTS ${P} (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
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

  const actions = {
    rules: { title: 'Access rules', run: async () => ({ policy: policy(), rules: rules(), rev: rev() }) },
    /** Add a rule. `remove` = ids of rules to delete first (e.g. blocks/asks that would override a new allow).
     *  With the default policy at allow, an allow rule only removes conflicts; it isn't stored (it would do nothing). */
    rule: { title: 'Add rule', run: async ({ action, kind, value, note, remove }: Record<string, any>) => {
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
    delete_rule: { title: 'Delete rule', run: async ({ id }: Record<string, any>) => { db().prepare(`DELETE FROM ${T} WHERE id=?`).run(Number(id)); changed(); } },
    /** Switch the default policy; `allow` = domains to add as allow rules in the same step (so switching to ask/deny doesn't break current traffic). */
    set_policy: { title: 'Set default policy', run: async ({ policy: p, allow }: Record<string, any>) => {
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
  return { rules, policy, rev, actions, onChange: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); } };
}

/**
 * Browser-side verdict: scheme table + rules. Mirror of browserVerdict() in the BrowserPaw fork
 * (app/chrome-extension/entrypoints/background/url-policy.ts); keep the two in step.
 * `top` = top-level navigation; `selfId` = the BrowserPaw extension id (its own pages are allowed).
 */
export function browserVerdict(raw: string, list: Pick<Rule, 'action' | 'kind' | 'value'>[], def: Policy, top: boolean, selfId?: string, depth = 0): Verdict {
  let u: URL;
  try { u = new URL(raw); } catch { return { blocked: 'invalid url' }; }
  const p = u.protocol;
  if (p === 'http:' || p === 'https:') return verdict(u, list, def);
  if (p === 'ws:' || p === 'wss:') return verdict(new URL(u.href.replace(/^ws/i, 'http')), list, def);
  if (p === 'about:') return /^about:(blank|srcdoc)$/i.test(u.href.split(/[?#]/)[0]!) ? { allowedBy: 'scheme: about:blank' } : { blocked: 'scheme: about:' };
  if (p === 'chrome:') return /^chrome:\/\/(newtab|new-tab-page)\//i.test(u.href) ? { allowedBy: 'scheme: chrome://newtab' } : { blocked: 'scheme: chrome:' };
  if (p === 'chrome-extension:') return selfId && u.hostname === selfId ? { allowedBy: 'scheme: this extension' } : { blocked: 'scheme: chrome-extension:' };
  if (p === 'data:') return top ? { blocked: 'scheme: data: (top-level)' } : { allowedBy: 'scheme: data:' };
  if ((p === 'view-source:' || p === 'blob:' || p === 'filesystem:') && depth < 3) {
    const inner = browserVerdict(raw.slice(p.length), list, def, top, selfId, depth + 1);
    if (p === 'view-source:' || inner.blocked) return inner;
    return /^https?:/i.test(raw.slice(p.length)) ? inner : { blocked: `scheme: ${p}` };
  }
  return { blocked: `scheme: ${p}` }; // file:, ftp:, ssh:, javascript:, devtools:, external app handlers, …
}
