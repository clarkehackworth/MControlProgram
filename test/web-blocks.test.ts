import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));

const site = http.createServer((req, res) => {
  if (req.url === '/hop') { res.writeHead(302, { location: '/secret/x' }); return res.end(); }
  res.writeHead(200); res.end('ok');
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as any).port}`;

test('blocks: normalize, match, enforce live (incl. redirects), and log every attempt', async () => {
  const web = (await import('../src/plugins/web/index.js')).default;
  const { verdict, normalizeBlock } = await import('../src/plugins/web/index.js');
  const { ScopedLogger } = await import('../src/core/logger.js');

  assert.deepEqual(normalizeBlock('domain', 'https://Sub.Example.com/a'), { kind: 'domain', value: 'sub.example.com' });
  assert.deepEqual(normalizeBlock('domain', '*.example.com'), { kind: 'domain', value: 'example.com' });
  assert.throws(() => normalizeBlock('regex', '('));
  assert.throws(() => normalizeBlock('domain', 'bad domain'));
  const L = [{ action: 'block' as const, kind: 'domain' as const, value: 'example.com' }, { action: 'allow' as const, kind: 'domain' as const, value: 'a.example.com' }, { action: 'allow' as const, kind: 'domain' as const, value: 'ok.com' }];
  assert.ok(verdict(new URL('https://a.example.com/'), L, 'allow').blocked, 'block beats allow');
  assert.equal(verdict(new URL('https://notexample.com/'), L, 'allow').blocked, undefined, 'suffix match needs a dot boundary');
  assert.equal(verdict(new URL('https://notexample.com/'), L, 'deny').blocked, 'default: deny');
  assert.equal(verdict(new URL('https://x.ok.com/'), L, 'deny').allowedBy, 'domain: ok.com');

  const act = (k: string, p: any = {}) => web.globalActions![k]!.run(p, {} as any);
  const inst = (await web.create({ instanceId: 'i', instanceName: 'web', serverId: 's', global: () => ({ stateIdleSec: 1, connectionIdleSec: 1, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'),
    config: { ...web.defaultConfig, blockPrivateNetworks: false }, pluginConfig: { credentials: [] } })) as any;
  const req = (url: string) => inst.tools.find((t: any) => t.name === 'request').handler({ url, method: 'GET' }, { principal: 'tok', signal: new AbortController().signal });

  assert.equal((await req(`${base}/secret/a`)).isError, false);
  await act('rule', { action: 'block', kind: 'url', value: `${base}/secret/` });
  const r = await req(`${base}/secret/a`);
  assert.match(r.content[0].text, /blocked by administrator/, 'block applies without restarting the instance');
  assert.match((await req(`${base}/hop`)).content[0].text, /blocked/, 'redirect hop into a blocked URL is refused');

  const { rows } = await act('requests', { since: 0 }) as any;
  assert.deepEqual(rows.map((x: any) => [x.url.replace(base, ''), x.status, x.blocked ? 'B' : '']),
    [['/secret/x', null, 'B'], ['/hop', 302, ''], ['/secret/a', null, 'B'], ['/secret/a', 200, '']]);
  assert.equal((await act('requests', { since: 0, outcome: 'blocked' }) as any).rows.length, 2);

  assert.equal(rows[3].allowed_by, 'default: allow');

  // allow under default=allow: removes the conflicting block, stores nothing
  const { rules: [b] } = await act('rules') as any;
  assert.equal((await act('rule', { action: 'allow', kind: 'url', value: `${base}/secret/`, remove: [b.id] }) as any).stored, false);
  assert.deepEqual((await act('rules') as any).rules, []);
  assert.equal((await req(`${base}/secret/a`)).isError, false, 'unblocked');

  // default deny: switching with an allow list keeps that host working, everything else is refused
  await act('set_policy', { policy: 'deny', allow: ['127.0.0.1'] });
  assert.equal((await req(`${base}/secret/a`)).isError, false, 'allowed host still works');
  assert.match((await req('http://localhost:1/')).content[0].text, /not on the administrator's allow list/);
  const latest = (await act('requests', { since: 0, limit: 2 }) as any).rows;
  assert.deepEqual(latest.map((x: any) => [x.blocked, x.allowed_by]), [['default: deny', null], [null, 'domain: 127.0.0.1']]);
  await act('set_policy', { policy: 'allow' });

  // rules and private ranges also apply to the address a name resolves to (app.local → 192.168.x)
  const port = (site.address() as any).port;
  await act('rule', { action: 'block', kind: 'domain', value: '127.0.0.1' });
  const viaName = await req(`http://localhost:${port}/`);
  assert.match(viaName.content[0].text, /blocked by administrator \(domain: 127\.0\.0\.1 \(localhost → 127\.0\.0\.1\)\)/);
  assert.equal((await act('requests', { since: 0, limit: 1 }) as any).rows[0].blocked, 'domain: 127.0.0.1 (localhost → 127.0.0.1)');
  await act('delete_rule', { id: (await act('rules') as any).rules[0].id });
  assert.equal((await req(`http://localhost:${port}/`)).isError, false);

  const { isPrivateHost } = await import('../src/plugins/web/index.js');
  for (const h of ['localhost', 'a.localhost', '127.9.9.9', '10.1.2.3', '192.168.0.5', '[::1]', '[::ffff:7f00:1]', '[fd00::1]', '0.0.0.0']) assert.ok(isPrivateHost(h), h);
  for (const h of ['8.8.8.8', 'example.com', '[2606:4700::1]', '172.32.0.1']) assert.ok(!isPrivateHost(h), h);
  // trailing dot names the same host: "evil.com." must not slip past a domain/url rule
  assert.ok(verdict(new URL('https://a.example.com./'), L, 'allow').blocked, 'trailing dot still matches domain rule');
  assert.deepEqual(normalizeBlock('domain', 'example.com.'), { kind: 'domain', value: 'example.com' });
  await act('rule', { action: 'block', kind: 'url', value: `http://localhost:${port}/secret/` });
  assert.match((await req(`http://localhost.:${port}/secret/x`)).content[0].text, /blocked by administrator/, 'trailing dot vs url prefix rule');
  await act('delete_rule', { id: (await act('rules') as any).rules[0].id });

  // non-http schemes are refused and logged
  for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'ssh://host/']) {
    assert.match((await req(u)).content[0].text, /only http\/https allowed/, u);
    assert.equal((await act('requests', { since: 0, limit: 1 }) as any).rows[0].blocked, `scheme: ${new URL(u).protocol}`, u);
  }

  inst.stop?.(); site.close();
});
