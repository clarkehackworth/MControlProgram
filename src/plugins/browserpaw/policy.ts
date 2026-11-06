/**
 * Browser URL policy: one block/allow list for every BrowserPaw profile, owned here and pushed to each
 * profile's extension (fork routes /url-policy*), which enforces it with declarativeNetRequest and
 * reports what it blocked/allowed. Also: the tool-argument pre-check and the request log.
 */
import { getDb } from '../../core/db.js';
import { ruleStore, browserVerdict } from '../../core/url-policy.js';
import type { ToolCallContext } from '../../core/plugin-api.js';

export const store = ruleStore('browserpaw', { re2: true });

let tablesReady = false;
const db = () => {
  const d = getDb();
  if (!tablesReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS browserpaw_requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, profile TEXT NOT NULL,
        principal TEXT, session_id TEXT, agent_via TEXT, tab_id INTEGER, type TEXT NOT NULL, method TEXT, url TEXT NOT NULL, host TEXT NOT NULL,
        blocked TEXT, allowed_by TEXT, initiator TEXT, via TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS browserpaw_requests_ts ON browserpaw_requests(ts);`);
    tablesReady = true;
  }
  return d;
};

interface Row { ts?: number; profile: string; principal?: string | null; sessionId?: string | null; agentVia?: string | null; tabId?: number | null;
  type: string; method?: string | null; url: string; blocked?: string | null; allowedBy?: string | null; initiator?: string | null; via: string }
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
export function record(r: Row) {
  db().prepare(`INSERT INTO browserpaw_requests(ts,profile,principal,session_id,agent_via,tab_id,type,method,url,host,blocked,allowed_by,initiator,via)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.ts ?? Date.now(), r.profile, r.principal ?? null, r.sessionId ?? null, r.agentVia ?? null, r.tabId ?? null,
    r.type, r.method ?? null, r.url, hostOf(r.url), r.blocked ?? null, r.allowedBy ?? null, r.initiator ?? null, r.via);
}
export const prune = (days: number) => db().prepare('DELETE FROM browserpaw_requests WHERE ts < ?').run(Date.now() - days * 86400_000);

// ---------- sync state (per profile, shared by every instance exposing it) ----------

export type BridgeCall = (method: 'GET' | 'PUT', path: string, body?: unknown) => Promise<any>;
interface Sync { ackRev?: number; epoch?: string; after: number; lastPush?: number; lastPull?: number; error?: string; rejected: { id: number; error: string }[] }
const syncs = new Map<string, Sync>();
const syncOf = (profile: string) => { let s = syncs.get(profile); if (!s) syncs.set(profile, (s = { after: 0, rejected: [] })); return s; };
const pushing = new Map<string, Promise<void>>();
const pulling = new Set<string>();

/** Push the current list. Throws (and leaves the profile out of sync) on failure. */
export function push(profile: string, call: BridgeCall): Promise<void> {
  let p = pushing.get(profile);
  if (p) return p;
  p = (async () => {
    const s = syncOf(profile);
    const rev = store.rev();
    try {
      const r = await call('PUT', '/url-policy', { rev, policy: store.policy(), rules: store.rules().map(({ id, action, kind, value }) => ({ id, action, kind, value })), logAllowed: 'navigation' });
      if (r?.status !== 'success' || r.rev !== rev) throw new Error(r?.error ?? 'extension did not acknowledge the policy');
      Object.assign(s, { ackRev: rev, lastPush: Date.now(), error: undefined, rejected: r.rejected ?? [] });
    } catch (e) {
      s.ackRev = undefined; s.error = `push failed: ${(e as Error).message}`;
      throw new Error(`browser URL policy could not be applied to profile ${profile} (${(e as Error).message}); browser tools are refused until it is`);
    }
  })().finally(() => pushing.delete(profile));
  pushing.set(profile, p);
  return p;
}

/** Fail closed: tool calls only go to a browser enforcing the current list. */
export async function ensureSynced(profile: string, call: BridgeCall) {
  if (syncOf(profile).ackRev !== store.rev()) await push(profile, call);
}

/** Pull new events into the log; the response's rev doubles as the heartbeat (a restarted/reset extension gets re-pushed). */
export async function pull(profile: string, call: BridgeCall) {
  if (pulling.has(profile)) return;
  pulling.add(profile);
  const s = syncOf(profile);
  try {
    for (let i = 0; i < 20; i++) { // at most 20k events per tick
      const r = await call('GET', `/url-policy/events?after=${s.after}&epoch=${encodeURIComponent(s.epoch ?? '')}&limit=1000`);
      if (r?.status !== 'success') throw new Error(r?.error ?? 'bad response');
      if (r.epoch !== s.epoch) { s.epoch = r.epoch; s.after = 0; }
      const d = db();
      d.transaction(() => {
        if (r.dropped) record({ profile, type: 'other', url: '', via: 'dropped', blocked: `${r.dropped} events lost (extension buffer overflowed)` });
        for (const e of r.events ?? []) record({ ...e, profile, ts: e.ts });
      })();
      const last = r.events?.at(-1)?.seq;
      if (last) s.after = last;
      s.lastPull = Date.now();
      if (r.rev !== store.rev()) { s.ackRev = r.rev ?? undefined; await push(profile, call).catch(() => {}); }
      if ((r.events?.length ?? 0) < 1000) break;
    }
    if (!s.error?.startsWith('push')) s.error = undefined;
  } catch (e) { s.error = `pull failed: ${(e as Error).message}`; }
  finally { pulling.delete(profile); }
}

export const syncStatus = () => Object.fromEntries([...syncs].map(([k, s]) => [k, { inSync: s.ackRev === store.rev(), ackRev: s.ackRev ?? null, rev: store.rev(), lastPush: s.lastPush ?? null, lastPull: s.lastPull ?? null, error: s.error ?? null, rejected: s.rejected }]));

// ---------- tool calls ----------

/** Tools whose `url` / `fileUrl` argument makes the browser load something. (chrome_close_tabs' url is a filter; bookmarks don't load.) */
const URL_TOOLS = new Set(['chrome_navigate', 'chrome_get_web_content', 'chrome_network_request', 'chrome_upload_file', 'chrome_insert_media', 'chrome_batch_actions']);
function urlArgs(tool: string, args: any): string[] {
  if (!URL_TOOLS.has(tool)) return [];
  const out: string[] = [];
  const walk = (v: any, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'url' || k === 'fileUrl') && typeof x === 'string' && x !== 'back' && x !== 'forward') out.push(x);
      else if (tool === 'chrome_batch_actions') walk(x, depth + 1);
    }
  };
  walk(args, 0);
  return out;
}

/**
 * Prepare a call: refuse blocked URL arguments (with a clear error and a log row) and stamp the caller
 * identity the extension uses to attribute tabs. Agent-supplied `_meta` is discarded: the native server
 * prefers arguments._meta over params._meta, so this overwrite is what makes the identity trustworthy.
 */
export function prepareCall(profile: string, tool: string, args: Record<string, any>, call: Pick<ToolCallContext, 'principal' | 'sessionId'>): Record<string, any> {
  const { _meta: _ignored, ...rest } = args;
  for (const url of urlArgs(tool, rest)) {
    const v = browserVerdict(url, store.rules(), store.policy(), true);
    if (v.blocked) {
      record({ profile, principal: call.principal, sessionId: call.sessionId, agentVia: 'tool', type: 'main_frame', url, blocked: v.blocked, via: 'tool-arg' });
      throw new Error(v.blocked === 'default: deny' ? `url not on the administrator's browser allow list: ${url}` : `url blocked by administrator (${v.blocked}): ${url}`);
    }
  }
  return { ...rest, _meta: { mcp: { principal: call.principal ?? null, sessionId: call.sessionId ?? null } } };
}

// ---------- admin actions ----------

export const actions = {
  ...store.actions,
  requests: { title: 'Request log', run: async (q: Record<string, any>) => {
    const where = ['ts >= ?', 'ts <= ?']; const args: unknown[] = [Number(q.since) || 0, Number(q.until) || Date.now()];
    if (q.q) { where.push('(url LIKE ? OR principal LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
    if (q.profile) { where.push('profile = ?'); args.push(q.profile); }
    if (q.principal) { where.push('principal = ?'); args.push(q.principal); }
    if (q.via) { where.push('via = ?'); args.push(q.via); }
    if (q.outcome === 'blocked') where.push('blocked IS NOT NULL');
    if (q.outcome === 'allowed') where.push('blocked IS NULL');
    const limit = Math.min(Number(q.limit) || 500, 5000);
    const rows = db().prepare(`SELECT * FROM browserpaw_requests WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  } },
  clear_requests: { title: 'Clear request log', run: async () => { db().prepare('DELETE FROM browserpaw_requests').run(); } },
  sync_status: { title: 'URL policy sync', run: async () => ({ rev: store.rev(), profiles: syncStatus() }) },
};
