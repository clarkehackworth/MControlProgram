/**
 * Web plugin: HTTP access with URL allow/deny policy. Credentials for specific origins are
 * injected server-side so agents never see them.
 */
import { z } from 'zod';
import type { MControlProgramPlugin, PluginContext, PluginInstance } from '../../core/plugin-api.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { getDb } from '../../core/db.js';
import { ruleStore, ruleMatches, verdict, label } from '../../core/url-policy.js';
export { ruleMatches, verdict, normalizeBlock, type BlockKind, type RuleAction, type Policy } from '../../core/url-policy.js';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, fetch, Headers, type Response } from 'undici';
import { safeRegex } from '../../core/safe-regex.js';

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
    blockPrivateNetworks: { type: 'boolean', title: 'Block private/loopback addresses', description: 'Refuse localhost, 10/8, 100.64/10, 127/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10, including names that resolve to them (e.g. app.local)', default: true },
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

const PRIVATE = new BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(a, n, 'ipv6');
/** True for loopback/private/link-local IPs (incl. v4-mapped v6) and localhost names. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const fam = isIP(h);
  return fam ? PRIVATE.check(h, fam === 4 ? 'ipv4' : 'ipv6') : h === 'localhost' || h.endsWith('.localhost');
}

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

// ---- request log + plugin-wide access rules (own tables: changing rules must not restart instances / drop cookie jars) ----
const store = ruleStore('web');
const { rules, policy } = store;
let tablesReady = false;
const db = () => {
  const d = getDb();
  if (!tablesReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS web_requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, server_id TEXT, instance TEXT, principal TEXT,
        method TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, status INTEGER, error TEXT, blocked TEXT, ms INTEGER);
      CREATE INDEX IF NOT EXISTS web_requests_ts ON web_requests(ts);`);
    try { d.exec('ALTER TABLE web_requests ADD COLUMN allowed_by TEXT'); } catch { /* exists */ }
    tablesReady = true;
  }
  return d;
};

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
      if (q.outcome === 'allowed') where.push('blocked IS NULL');
      if (q.outcome === 'error') where.push('blocked IS NULL AND (error IS NOT NULL OR status >= 400)');
      const limit = Math.min(Number(q.limit) || 500, 5000);
      const rows = db().prepare(`SELECT * FROM web_requests WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1);
      return { rows: rows.slice(0, limit), more: rows.length > limit };
    } },
    ...store.actions,
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
    const waiters: Array<() => void> = []; // ponytail: FIFO wait for a free slot instead of failing parallel tool calls
    const re = (p: string) => safeRegex(p, 'i');
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
        const allowedBy = r.blocked ? null : verdict(u, rules(), policy()).allowedBy ?? null;
        db().prepare('INSERT INTO web_requests(ts,server_id,instance,principal,method,url,host,status,error,blocked,allowed_by,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(Date.now(), ctx.serverId, ctx.instanceName, c.principal ?? null, method, u.href, u.hostname, r.status ?? null, r.error ?? null, r.blocked ?? null, allowedBy, r.ms ?? null);
      } catch (e) { ctx.log.warn(`request log write failed: ${(e as Error).message}`); }
    };
    class Blocked extends Error { constructor(public rule: string, msg?: string) { super(msg ?? (rule === 'default: deny' ? 'url not on the administrator\'s allow list' : `url blocked by administrator (${rule})`)); } }

    /** Deny checks that also apply to an address a name resolves to (block rules, denyUrls, private ranges). Allow rules don't: allowing a name allows what it resolves to. */
    function checkAddress(ip: string, name: string) {
      const u = new URL(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}/`);
      const b = rules().find((r) => r.action === 'block' && ruleMatches(r, u));
      if (b) throw new Blocked(`${label(b)} (${name} → ${ip})`);
      if (cfg.blockPrivateNetworks && isPrivateHost(ip)) throw new Error(`private network addresses are blocked (${name} → ${ip})`);
      for (const p of cfg.denyUrls ?? []) if (p && re(p).test(u.href)) throw new Error(`url denied by policy (${p}; ${name} → ${ip})`);
    }
    // Checked at connect time on the address actually dialed, so DNS rebinding can't swap in a private IP after the check.
    const guardedLookup: LookupFunction = (host, opts, cb) => dnsLookup(host, { ...opts, all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return cb(err, '', 0);
      try { for (const a of addrs) checkAddress(a.address, host); } catch (e) { return cb(e as NodeJS.ErrnoException, '', 0); }
      if (opts.all) (cb as any)(null, addrs); else cb(null, addrs[0]!.address, addrs[0]!.family);
    });
    const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

    function checkUrl(raw: string): URL {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) throw new Blocked(`scheme: ${u.protocol}`, `only http/https allowed (got ${u.protocol})`); // logged like any block
      // Trailing dots name the same host ("evil.com." = evil.com, "localhost." = localhost); canonicalize so rules, prefixes and private checks all see one form.
      if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
      const v = verdict(u, rules(), policy()); if (v.blocked) throw new Blocked(v.blocked);
      if (cfg.blockPrivateNetworks && isPrivateHost(u.hostname)) throw new Error('private network addresses are blocked');
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
      while (inflight >= cfg.maxConcurrent) await new Promise<void>((r) => waiters.push(r));
      const jar = jarFor(caller);
      inflight++; total++;
      const t0 = Date.now();
      try {
        let res: Response; let hops = 0; let cred: string | undefined; let shown = u.href; // shown = URL without query credentials
        // Redirects are followed manually so each hop gets policy checks and the right cookies.
        for (;;) {
          const headers = new Headers({ 'user-agent': cfg.userAgent, ...(cfg.defaultHeaders ?? {}), ...(hdrs ?? {}) });
          headers.delete('cookie'); // agents never set or see cookies directly; the jar owns them
          const logged = new URL(u); shown = logged.href; // before applyCreds: query-type credentials must never reach the log
          cred = applyCreds(u, headers);
          const ck = jar?.header(u); if (ck) headers.set('cookie', ck);
          const th = Date.now();
          try { res = await fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs), dispatcher }); }
          catch (e) {
            const cause = (e as Error).cause; // undici wraps lookup/connect errors in "fetch failed"
            if (cause instanceof Blocked) record(method, logged, { blocked: cause.rule }, caller);
            else record(method, logged, { error: cause instanceof Error ? cause.message : (e as Error).message, ms: Date.now() - th }, caller);
            throw cause instanceof Error ? cause : e;
          }
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
        return { res, buf, truncated, finalUrl: shown };
      } catch (e) {
        ctx.log.connection(`${method} ${u.origin}${u.pathname} FAILED ${(e as Error).message}`, undefined, caller.sessionId);
        throw e;
      } finally { inflight--; waiters.shift()?.(); }
    }

    return {
      start() {
        reaper = setInterval(() => {
          const idle = effective(cfg.cookieIdleSec, ctx.global().stateIdleSec);
          for (const [k, j] of jars) if (Date.now() - j.lastUsed > idle * 1000) { jars.delete(k); ctx.log.debug(`cookie jar ${k} discarded (idle)`); }
          db().prepare('DELETE FROM web_requests WHERE ts < ?').run(Date.now() - ctx.global().logRetentionDays * 86400_000);
        }, 60_000);
      },
      stop() { if (reaper) clearInterval(reaper); jars.clear(); void dispatcher.close(); },
      onSessionClosed(sessionId) { if (cfg.cookieScope === 'session') jars.delete(`session:${sessionId}`); },
      status: () => ({ inflight, total, failed, credentials: creds.map((c) => c.name), cookieScope: cfg.cookies ? cfg.cookieScope : 'off', cookieIdleSec: effective(cfg.cookieIdleSec, ctx.global().stateIdleSec), cookieJars: jars.size }),
      tools: [
        {
          name: 'policy', description: 'Show this gateway\'s URL policy (allowed/denied patterns, methods) and which origins have credentials configured.',
          annotations: { readOnlyHint: true },
          handler: async () => text(JSON.stringify({ defaultPolicy: policy(), rules: rules().map((r) => ({ action: r.action, kind: r.kind, value: r.value })), allowUrls: cfg.allowUrls, denyUrls: cfg.denyUrls, allowMethods: cfg.allowMethods, blockPrivateNetworks: cfg.blockPrivateNetworks,
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
