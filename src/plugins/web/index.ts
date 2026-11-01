/**
 * Web plugin: HTTP access with URL allow/deny policy. Credentials for specific origins are
 * injected server-side so agents never see them.
 */
import { z } from 'zod';
import type { MControlProgramPlugin, PluginContext, PluginInstance } from '../../core/plugin-api.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { getDb } from '../../core/db.js';

interface CredCfg { name: string; urlPattern: string; type: 'header' | 'basic' | 'bearer' | 'query'; headerName?: string; username?: string; secret: string }
interface Cfg {
  allowUrls: string[]; denyUrls: string[]; allowMethods: string[]; blockPrivateNetworks: boolean;
  maxResponseBytes: number; timeoutMs: number; followRedirects: boolean; userAgent: string;
  defaultHeaders: Record<string, string>; credentials: string[]; credentialsDisabled?: string[]; maxConcurrent: number;
  cookies: boolean; cookieScope: 'principal' | 'session' | 'shared'; cookieIdleSec: number;
}

const configSchema = {
  type: 'object',
  properties: {
    allowUrls: { type: 'array', title: 'Allowed URL patterns (regex)', description: 'If non-empty, requests must match one of these. Example: ^https://api\\.github\\.com/', items: { type: 'string' } },
    denyUrls: { type: 'array', title: 'Denied URL patterns (regex)', description: 'Checked before the allow list.', items: { type: 'string' } },
    allowMethods: { type: 'array', title: 'Allowed HTTP methods', default: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], items: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] } },
    blockPrivateNetworks: { type: 'boolean', title: 'Block private/loopback addresses', description: 'Refuse localhost, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1', default: true },
    followRedirects: { type: 'boolean', title: 'Follow redirects', default: true },
    maxResponseBytes: { type: 'integer', title: 'Max response bytes', default: 1000000 },
    timeoutMs: { type: 'integer', title: 'Request timeout (ms)', default: 30000 },
    maxConcurrent: { type: 'integer', title: 'Max concurrent requests', default: 8 },
    userAgent: { type: 'string', title: 'User-Agent', default: 'MControlProgram/0.1 (+mcp-gateway)' },
    defaultHeaders: { type: 'object', title: 'Default headers', additionalProperties: { type: 'string' } },
    cookies: { type: 'boolean', title: 'Cookie jar', description: 'Remember Set-Cookie between requests (needed for logged-in browsing). Agents never see raw cookie values.', default: true },
    cookieScope: { type: 'string', title: 'Cookie isolation', enum: ['principal', 'session', 'shared'], default: 'principal',
      description: 'principal: each token/OAuth client has its own jar (survives reconnect). session: jar dies with the MCP session. shared: all agents share one jar.' },
    cookieIdleSec: { type: 'integer', title: 'Cookie jar idle timeout (seconds)', description: 'Jars unused for this long are discarded. 0 = use the MControlProgram-wide state idle timeout (Settings).', default: 0 },
    credentials: { type: 'array', title: 'Enabled credentials', description: 'Credentials from the plugin inventory to inject on this server. Empty = none.', items: { type: 'string', 'x-options-from': 'credentials' }, 'x-disabled-key': 'credentialsDisabled' },
    credentialsDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true },
  },
};

/** Plugin-wide: credential inventory shared by all web instances. */
const globalConfigSchema = {
  type: 'object',
  properties: {
    credentials: {
      type: 'array', title: 'Credentials', description: 'Secrets attached to requests whose URL matches the pattern. Agents never see them. Instances choose which to enable.',
      items: {
        type: 'object', required: ['name', 'urlPattern', 'type', 'secret'],
        properties: {
          name: { type: 'string', title: 'Name' },
          urlPattern: { type: 'string', title: 'URL pattern (regex)', description: 'e.g. ^https://api\\.github\\.com/' },
          type: { type: 'string', title: 'Type', enum: ['bearer', 'basic', 'header', 'query'], default: 'bearer' },
          headerName: { type: 'string', title: 'Header / query param name', description: 'For type=header or query' },
          username: { type: 'string', title: 'Username', description: 'For type=basic' },
          secret: { type: 'string', title: 'Secret / token / password', 'x-secret': true },
        },
      },
    },
  },
};

const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./, /^\[?::1\]?$/, /^\[?fc/i, /^\[?fd/i, /^\[?fe80/i];

interface Cookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires?: number }
/** Minimal RFC 6265 jar: one per isolation scope. No HttpOnly/SameSite enforcement needed (no scripts run here). */
class CookieJar {
  cookies = new Map<string, Cookie>(); // key: domain|path|name
  lastUsed = Date.now();
  store(u: URL, setCookies: string[]) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('='); if (eq < 1) continue;
      const c: Cookie = { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1).trim(), domain: u.hostname, hostOnly: true, path: defaultPath(u.pathname), secure: false };
      for (const a of attrs) {
        const [k, ...v] = a.trim().split('='); const val = v.join('=');
        switch (k!.toLowerCase()) {
          case 'domain': { const d = val.replace(/^\./, '').toLowerCase(); if (d && (u.hostname === d || u.hostname.endsWith('.' + d))) { c.domain = d; c.hostOnly = false; } break; }
          case 'path': if (val.startsWith('/')) c.path = val; break;
          case 'secure': c.secure = true; break;
          case 'max-age': { const n = Number(val); if (!isNaN(n)) c.expires = Date.now() + n * 1000; break; }
          case 'expires': if (c.expires === undefined) { const t = Date.parse(val); if (!isNaN(t)) c.expires = t; } break;
        }
      }
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (c.expires !== undefined && c.expires <= Date.now()) this.cookies.delete(key); else this.cookies.set(key, c);
    }
  }
  header(u: URL): string | undefined {
    const now = Date.now(); const out: string[] = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== undefined && c.expires <= now) { this.cookies.delete(k); continue; }
      if (c.secure && u.protocol !== 'https:') continue;
      if (c.hostOnly ? u.hostname !== c.domain : !(u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) continue;
      if (!(u.pathname === c.path || (u.pathname.startsWith(c.path) && (c.path.endsWith('/') || u.pathname[c.path.length] === '/')))) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.length ? out.join('; ') : undefined;
  }
  summary() { return [...this.cookies.values()].map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, expires: c.expires ? new Date(c.expires).toISOString() : 'session' })); }
}
const defaultPath = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, h, t) => `${t.replace(/<[^>]+>/g, '').trim()} (${h})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- request log + plugin-wide blocks (own tables: changing blocks must not restart instances / drop cookie jars) ----
export type BlockKind = 'domain' | 'url' | 'regex';
interface Block { id: number; kind: BlockKind; value: string; note: string; created_at: number }
let tablesReady = false;
const db = () => {
  const d = getDb();
  if (!tablesReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS web_requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
        method TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, status INTEGER, error TEXT, blocked TEXT, ms INTEGER);
      CREATE INDEX IF NOT EXISTS web_requests_ts ON web_requests(ts);
      CREATE TABLE IF NOT EXISTS web_blocks (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(kind, value));`);
    tablesReady = true;
  }
  return d;
};
let blockCache: Block[] | undefined;
const blocks = () => (blockCache ??= db().prepare('SELECT * FROM web_blocks ORDER BY kind, value').all() as Block[]);

/** The block rule that matches `u`, if any. Domain = host or any subdomain; URL = prefix; regex = case-insensitive on the full URL. */
export function blockedBy(u: URL, list: Pick<Block, 'kind' | 'value'>[]): string | undefined {
  const host = u.hostname.toLowerCase();
  for (const b of list) {
    const hit = b.kind === 'domain' ? host === b.value || host.endsWith('.' + b.value)
      : b.kind === 'url' ? u.href.startsWith(b.value)
      : (() => { try { return new RegExp(b.value, 'i').test(u.href); } catch { return false; } })();
    if (hit) return `${b.kind}: ${b.value}`;
  }
}

export function normalizeBlock(kind: string, raw: string): { kind: BlockKind; value: string } {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('value is required');
  if (kind === 'domain') {
    const d = (/^[a-z]+:\/\//i.test(v) ? new URL(v).hostname : v.split('/')[0]!).replace(/^\*?\./, '').toLowerCase();
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(d)) throw new Error(`"${v}" is not a domain`);
    return { kind, value: d };
  }
  if (kind === 'url') {
    const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`); // throws on garbage
    return { kind, value: u.href };
  }
  if (kind === 'regex') { new RegExp(v, 'i'); return { kind, value: v }; }
  throw new Error(`unknown block kind "${kind}"`);
}

const plugin: MControlProgramPlugin = {
  id: 'web', name: 'Web', version: '0.1.0',
  description: 'HTTP requests and page fetching with URL filtering and server-side credential injection.',
  configSchema,
  globalConfigSchema,
  globalActions: {
    // ponytail: driven by the custom Traffic panel on the plugin page; hidden from the generic inventory buttons
    requests: { title: 'Request log', run: async (q) => {
      const where = ['ts >= ?', 'ts <= ?']; const args: any[] = [Number(q.since) || 0, Number(q.until) || Date.now()];
      if (q.q) { where.push('(url LIKE ? OR principal LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
      if (q.method) { where.push('method = ?'); args.push(q.method); }
      if (q.server) { where.push('server_id = ?'); args.push(q.server); }
      if (q.outcome === 'blocked') where.push('blocked IS NOT NULL');
      if (q.outcome === 'error') where.push('blocked IS NULL AND (error IS NOT NULL OR status >= 400)');
      if (q.outcome === 'ok') where.push('blocked IS NULL AND error IS NULL AND status < 400');
      const limit = Math.min(Number(q.limit) || 500, 5000);
      const rows = db().prepare(`SELECT * FROM web_requests WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1);
      return { rows: rows.slice(0, limit), more: rows.length > limit };
    } },
    blocks: { title: 'Blocks', run: async () => blocks() },
    block: { title: 'Block', run: async ({ kind, value, note }) => {
      const b = normalizeBlock(kind, value);
      db().prepare('INSERT INTO web_blocks(kind,value,note,created_at) VALUES(?,?,?,?) ON CONFLICT(kind,value) DO UPDATE SET note=excluded.note').run(b.kind, b.value, String(note ?? ''), Date.now());
      blockCache = undefined; return b;
    } },
    unblock: { title: 'Unblock', run: async ({ id }) => { db().prepare('DELETE FROM web_blocks WHERE id=?').run(Number(id)); blockCache = undefined; } },
    clear_requests: { title: 'Clear request log', run: async () => { db().prepare('DELETE FROM web_requests').run(); } },
  },
  defaultGlobalConfig: { credentials: [] },
  defaultConfig: { allowUrls: [], denyUrls: [], allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], blockPrivateNetworks: true, followRedirects: true,
    maxResponseBytes: 1_000_000, timeoutMs: 30000, maxConcurrent: 8, userAgent: 'MControlProgram/0.1 (+mcp-gateway)', defaultHeaders: {}, credentials: [],
    cookies: true, cookieScope: 'principal', cookieIdleSec: 0 },

  create(ctx: PluginContext): PluginInstance {
    const cfg = ctx.config as Cfg;
    const allCreds = ((ctx.pluginConfig.credentials as CredCfg[] | undefined) ?? []);
    const creds = allCreds.filter((c) => (cfg.credentials ?? []).includes(c.name) && !(cfg.credentialsDisabled ?? []).includes(c.name));
    let inflight = 0; let total = 0; let failed = 0;
    const re = (p: string) => new RegExp(p, 'i');
    type Caller = { sessionId?: string; principal?: string };
    const jars = new Map<string, CookieJar>();
    let reaper: NodeJS.Timeout | undefined;
    const scopeKey = (c: Caller) => cfg.cookieScope === 'shared' ? 'shared' : cfg.cookieScope === 'session' ? `session:${c.sessionId ?? 'none'}` : `principal:${c.principal ?? 'anonymous'}`;
    const jarFor = (c: Caller) => {
      if (!cfg.cookies) return undefined;
      const k = scopeKey(c); let j = jars.get(k);
      if (!j) { j = new CookieJar(); jars.set(k, j); }
      j.lastUsed = Date.now();
      return j;
    };

    const record = (method: string, u: URL, r: { status?: number; error?: string; blocked?: string; ms?: number }, c: Caller) => {
      try {
        db().prepare('INSERT INTO web_requests(ts,server_id,instance,principal,method,url,host,status,error,blocked,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(Date.now(), ctx.serverId, ctx.instanceName, c.principal ?? null, method, u.href, u.hostname, r.status ?? null, r.error ?? null, r.blocked ?? null, r.ms ?? null);
      } catch (e) { ctx.log.warn(`request log write failed: ${(e as Error).message}`); }
    };
    class Blocked extends Error { constructor(public rule: string) { super(`url blocked by administrator (${rule})`); } }

    function checkUrl(raw: string): URL {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https allowed');
      const b = blockedBy(u, blocks()); if (b) throw new Blocked(b);
      if (cfg.blockPrivateNetworks && PRIVATE.some((r) => r.test(u.hostname))) throw new Error('private network addresses are blocked');
      for (const p of cfg.denyUrls ?? []) if (p && re(p).test(u.href)) throw new Error(`url denied by policy (${p})`);
      const allow = (cfg.allowUrls ?? []).filter(Boolean);
      if (allow.length && !allow.some((p) => re(p).test(u.href))) throw new Error('url not in allow list');
      return u;
    }

    function applyCreds(u: URL, headers: Headers) {
      for (const c of creds) {
        if (!c.urlPattern || !re(c.urlPattern).test(u.href)) continue;
        switch (c.type) {
          case 'bearer': headers.set('Authorization', `Bearer ${c.secret}`); break;
          case 'basic': headers.set('Authorization', 'Basic ' + Buffer.from(`${c.username ?? ''}:${c.secret}`).toString('base64')); break;
          case 'header': headers.set(c.headerName || 'Authorization', c.secret); break;
          case 'query': u.searchParams.set(c.headerName || 'key', c.secret); break;
        }
        return c.name;
      }
    }

    async function doFetch(method: string, url: string, hdrs: Record<string, string> | undefined, body: string | undefined, caller: Caller) {
      if (!(cfg.allowMethods ?? []).includes(method)) throw new Error(`method ${method} not allowed`);
      let u: URL;
      try { u = checkUrl(url); } catch (e) {
        if (e instanceof Blocked) record(method, new URL(url), { blocked: e.rule }, caller);
        throw e;
      }
      if (inflight >= cfg.maxConcurrent) throw new Error('too many concurrent requests');
      const jar = jarFor(caller);
      inflight++; total++;
      const t0 = Date.now();
      try {
        let res: Response; let hops = 0; let cred: string | undefined;
        // Redirects are followed manually so each hop gets policy checks and the right cookies.
        for (;;) {
          const headers = new Headers({ 'user-agent': cfg.userAgent, ...(cfg.defaultHeaders ?? {}), ...(hdrs ?? {}) });
          headers.delete('cookie'); // agents never set or see cookies directly; the jar owns them
          const logged = new URL(u); // before applyCreds: query-type credentials must never reach the log
          cred = applyCreds(u, headers);
          const ck = jar?.header(u); if (ck) headers.set('cookie', ck);
          const th = Date.now();
          try { res = await fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) }); }
          catch (e) { record(method, logged, { error: (e as Error).message, ms: Date.now() - th }, caller); throw e; }
          record(method, logged, { status: res.status, ms: Date.now() - th }, caller);
          jar?.store(u, res.headers.getSetCookie());
          const loc = res.headers.get('location');
          if (!cfg.followRedirects || !loc || ![301, 302, 303, 307, 308].includes(res.status) || hops++ >= 10) break;
          await res.body?.cancel();
          const next = new URL(loc, u).href;
          try { u = checkUrl(next); } catch (e) {
            if (e instanceof Blocked) record(method, new URL(next), { blocked: e.rule }, caller);
            throw e;
          }
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        }
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = []; let size = 0; let truncated = false;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > cfg.maxResponseBytes) { truncated = true; chunks.push(value.subarray(0, value.length - (size - cfg.maxResponseBytes))); reader.cancel(); break; }
          chunks.push(value);
        }
        const buf = Buffer.concat(chunks);
        ctx.log.connection(`${method} ${u.origin}${u.pathname} -> ${res.status} ${buf.length}b ${Date.now() - t0}ms${cred ? ` cred=${cred}` : ''}${jar ? ` jar=${scopeKey(caller)}` : ''}`, undefined, caller.sessionId);
        return { res, buf, truncated, finalUrl: u.href };
      } catch (e) {
        ctx.log.connection(`${method} ${u.origin}${u.pathname} FAILED ${(e as Error).message}`, undefined, caller.sessionId);
        throw e;
      } finally { inflight--; }
    }

    return {
      start() {
        reaper = setInterval(() => {
          const idle = effective(cfg.cookieIdleSec, ctx.global().stateIdleSec);
          for (const [k, j] of jars) if (Date.now() - j.lastUsed > idle * 1000) { jars.delete(k); ctx.log.debug(`cookie jar ${k} discarded (idle)`); }
          db().prepare('DELETE FROM web_requests WHERE ts < ?').run(Date.now() - ctx.global().logRetentionDays * 86400_000);
        }, 60_000);
      },
      stop() { if (reaper) clearInterval(reaper); jars.clear(); },
      onSessionClosed(sessionId) { if (cfg.cookieScope === 'session') jars.delete(`session:${sessionId}`); },
      status: () => ({ inflight, total, failed, credentials: creds.map((c) => c.name), cookieScope: cfg.cookies ? cfg.cookieScope : 'off', cookieIdleSec: effective(cfg.cookieIdleSec, ctx.global().stateIdleSec), cookieJars: jars.size }),
      tools: [
        {
          name: 'policy', description: 'Show this gateway\'s URL policy (allowed/denied patterns, methods) and which origins have credentials configured.',
          annotations: { readOnlyHint: true },
          handler: async () => text(JSON.stringify({ blocked: blocks().map((b) => ({ kind: b.kind, value: b.value })), allowUrls: cfg.allowUrls, denyUrls: cfg.denyUrls, allowMethods: cfg.allowMethods, blockPrivateNetworks: cfg.blockPrivateNetworks,
            credentials: creds.map((c) => ({ name: c.name, urlPattern: c.urlPattern })) }, null, 2)),
        },
        {
          name: 'cookies', description: 'List the cookies in your jar (names and domains only, never values), or clear it. Cookies are remembered automatically between your requests.',
          inputSchema: { clear: z.boolean().optional().describe('Discard all cookies in your jar') },
          handler: async ({ clear }, c) => {
            if (!cfg.cookies) return text('cookie jar is disabled on this gateway');
            if (clear) { jars.delete(scopeKey(c)); return text('cookie jar cleared'); }
            const j = jars.get(scopeKey(c));
            return text(JSON.stringify({ scope: cfg.cookieScope, cookies: j?.summary() ?? [] }, null, 2));
          },
        },
        {
          name: 'request', description: 'Make an HTTP request. Returns status, headers and body (text; binary is base64). Credentials for configured origins and cookies from your jar are injected automatically; redirects are followed.',
          inputSchema: {
            url: z.string().url(), method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional().default('GET'),
            headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(),
            json: z.any().optional().describe('If set, sent as JSON body with content-type application/json'),
          },
          handler: async ({ url, method, headers, body, json }, c) => {
            try {
              const h = { ...(headers ?? {}) };
              let b = body;
              if (json !== undefined) { b = JSON.stringify(json); h['content-type'] ??= 'application/json'; }
              const { res, buf, truncated, finalUrl } = await doFetch(method ?? 'GET', url, h, b, c);
              const ct = res.headers.get('content-type') ?? '';
              const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+(json|xml))/.test(ct) || ct === '';
              const bodyOut = isText ? buf.toString('utf8') : buf.toString('base64');
              const hdrs: Record<string, string> = {}; res.headers.forEach((v, k) => (hdrs[k] = v));
              delete hdrs['set-cookie']; // jar-owned; never exposed to agents
              return { content: [{ type: 'text', text: `HTTP ${res.status} ${res.statusText}\nURL: ${finalUrl}\n${Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${bodyOut}${truncated ? '\n…[truncated]' : ''}` }],
                isError: res.status >= 400, structuredContent: { status: res.status, url: finalUrl, headers: hdrs, body: bodyOut, encoding: isText ? 'utf8' : 'base64', truncated } };
            } catch (e) { failed++; return errorResult(e); }
          },
        },
        {
          name: 'fetch_page', description: 'Fetch a web page and return readable text (scripts/styles stripped, links kept as "text (url)").',
          annotations: { readOnlyHint: true },
          inputSchema: { url: z.string().url(), maxChars: z.number().int().positive().optional().default(50000) },
          handler: async ({ url, maxChars }, c) => {
            try {
              const { res, buf, finalUrl } = await doFetch('GET', url, { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' }, undefined, c);
              const ct = res.headers.get('content-type') ?? '';
              const raw = buf.toString('utf8');
              const out = /html/.test(ct) ? htmlToText(raw) : raw;
              const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim();
              return text(`${title ? `# ${title}\n` : ''}URL: ${finalUrl}\nStatus: ${res.status}\n\n${out.length > maxChars ? out.slice(0, maxChars) + '\n…[truncated]' : out}`, res.status >= 400);
            } catch (e) { failed++; return errorResult(e); }
          },
        },
      ],
    };
  },
};

export default plugin;
