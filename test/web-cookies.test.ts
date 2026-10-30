import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));

// Tiny site: /login sets a cookie and redirects to /me; /me echoes the Cookie header; /other sets a path-scoped cookie.
const site = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  if (u.pathname === '/login') { res.writeHead(302, { 'set-cookie': [`sid=${u.searchParams.get('as')}; Path=/; HttpOnly`, 'tmp=1; Max-Age=0'], location: '/me' }); return res.end(); }
  if (u.pathname === '/me') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`cookie=${req.headers.cookie ?? ''}`); }
  if (u.pathname === '/scoped/set') { res.writeHead(200, { 'set-cookie': 'p=1; Path=/scoped' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as any).port}`;

const mk = async (over: Record<string, unknown>) => {
  const web = (await import('../src/plugins/web/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  const inst = (await web.create({ instanceId: 'i', instanceName: 'web', serverId: 's', global: () => ({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'), config: { ...web.defaultConfig, blockPrivateNetworks: false, ...over }, pluginConfig: { credentials: [] } })) as any;
  inst.start?.();
  const req = (args: any, principal: string, sessionId = 'sess-' + principal) => inst.tools.find((t: any) => t.name === 'request').handler(args, { principal, sessionId, signal: new AbortController().signal, log: new ScopedLogger({}, () => 'off') });
  const body = (r: any) => r.structuredContent.body as string;
  return { inst, req, body };
};

test('cookieScope=principal: jar follows the token, redirects carry cookies, agents are isolated', async () => {
  const { inst, req, body } = await mk({ cookieScope: 'principal' });
  const r = await req({ url: `${base}/login?as=alice` }, 'token:A');
  assert.equal(r.structuredContent.status, 200, 'redirect followed');
  assert.equal(body(r), 'cookie=sid=alice', 'cookie set by /login sent to /me on the redirect hop');
  assert.equal(r.structuredContent.headers['set-cookie'], undefined, 'set-cookie never exposed to agents');
  assert.equal(body(await req({ url: `${base}/me` }, 'token:A', 'new-session')), 'cookie=sid=alice', 'same principal, new MCP session: jar persists');
  assert.equal(body(await req({ url: `${base}/me` }, 'token:B')), 'cookie=', 'other principal has an empty jar');
  assert.equal(body(await req({ url: `${base}/me`, headers: { cookie: 'sid=forged' } }, 'token:B')), 'cookie=', 'agents cannot inject cookies by header');
  // path scoping
  await req({ url: `${base}/scoped/set` }, 'token:A');
  assert.equal(body(await req({ url: `${base}/me` }, 'token:A')), 'cookie=sid=alice', 'path-scoped cookie not sent outside its path');
  const list = await inst.tools.find((t: any) => t.name === 'cookies').handler({}, { principal: 'token:A', signal: new AbortController().signal });
  assert.match(list.content[0].text, /"name": "sid"/); assert.doesNotMatch(list.content[0].text, /alice/, 'values never listed');
  await inst.tools.find((t: any) => t.name === 'cookies').handler({ clear: true }, { principal: 'token:A', signal: new AbortController().signal });
  assert.equal(body(await req({ url: `${base}/me` }, 'token:A')), 'cookie=', 'cleared');
  inst.stop();
});

test('cookieScope=session dies with the session; shared is common; cookies=false disables', async () => {
  let { inst, req, body } = await mk({ cookieScope: 'session' });
  await req({ url: `${base}/login?as=s1` }, 'A', 's1');
  assert.equal(body(await req({ url: `${base}/me` }, 'A', 's2')), 'cookie=', 'other session of same principal sees nothing');
  inst.onSessionClosed('s1');
  assert.equal(body(await req({ url: `${base}/me` }, 'A', 's1')), 'cookie=', 'jar gone after session closed');
  inst.stop();
  ({ inst, req, body } = await mk({ cookieScope: 'shared' }));
  await req({ url: `${base}/login?as=everyone` }, 'A');
  assert.equal(body(await req({ url: `${base}/me` }, 'B')), 'cookie=sid=everyone');
  inst.stop();
  ({ inst, req, body } = await mk({ cookies: false }));
  await req({ url: `${base}/login?as=x` }, 'A');
  assert.equal(body(await req({ url: `${base}/me` }, 'A')), 'cookie=');
  inst.stop();
  site.close();
});
