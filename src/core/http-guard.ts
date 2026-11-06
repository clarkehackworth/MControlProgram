/** Shared HTTP hardening for the admin app and each MCP server app. */
import type { Request, Response, NextFunction } from 'express';

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
const isLoopbackBind = (h: string) => LOOPBACK.test(h) || h === '::1';
const hostname = (h: string) => h.replace(/:\d+$/, '');

/**
 * Clickjacking headers always. If the app is bound to loopback, also refuse any Host header that isn't a loopback name
 * or the configured public URL's host: otherwise a DNS-rebinding page can reach the app as if same-origin.
 */
export function guard(bindHost: string, publicUrl?: string | null) {
  let pub: string | undefined; try { pub = publicUrl ? new URL(publicUrl).hostname.toLowerCase() : undefined; } catch { /* ignore */ }
  return (req: Request, res: Response, next: NextFunction) => {
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    if (isLoopbackBind(bindHost)) {
      const h = hostname(String(req.headers.host ?? '')).toLowerCase();
      if (!LOOPBACK.test(h) && h !== pub) { res.status(403).type('text').send('forbidden host'); return; }
    }
    next();
  };
}

/** Failed-login throttle per remote address: 10 failures per 15 minutes. ponytail: in-memory, per process. */
const fails = new Map<string, { n: number; reset: number }>();
export const throttle = {
  blocked(req: Request) { const f = fails.get(req.ip ?? ''); return !!f && f.reset > Date.now() && f.n >= 10; },
  fail(req: Request) {
    const k = req.ip ?? ''; const f = fails.get(k);
    if (!f || f.reset <= Date.now()) { if (fails.size > 5000) fails.clear(); fails.set(k, { n: 1, reset: Date.now() + 15 * 60e3 }); } else f.n++;
  },
  ok(req: Request) { fails.delete(req.ip ?? ''); },
};
