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
  const { blockedBy, normalizeBlock } = await import('../src/plugins/web/index.js');
  const { ScopedLogger } = await import('../src/core/logger.js');

  assert.deepEqual(normalizeBlock('domain', 'https://Sub.Example.com/a'), { kind: 'domain', value: 'sub.example.com' });
  assert.deepEqual(normalizeBlock('domain', '*.example.com'), { kind: 'domain', value: 'example.com' });
  assert.throws(() => normalizeBlock('regex', '('));
  assert.throws(() => normalizeBlock('domain', 'bad domain'));
  const L = [{ kind: 'domain' as const, value: 'example.com' }];
  assert.ok(blockedBy(new URL('https://a.example.com/'), L));
  assert.equal(blockedBy(new URL('https://notexample.com/'), L), undefined, 'suffix match needs a dot boundary');

  const act = (k: string, p: any = {}) => web.globalActions![k]!.run(p, {} as any);
  const inst = (await web.create({ instanceId: 'i', instanceName: 'web', serverId: 's', global: () => ({ stateIdleSec: 1, connectionIdleSec: 1, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'),
    config: { ...web.defaultConfig, blockPrivateNetworks: false }, pluginConfig: { credentials: [] } })) as any;
  const req = (url: string) => inst.tools.find((t: any) => t.name === 'request').handler({ url, method: 'GET' }, { principal: 'tok', signal: new AbortController().signal });

  assert.equal((await req(`${base}/secret/a`)).isError, false);
  await act('block', { kind: 'url', value: `${base}/secret/` });
  const r = await req(`${base}/secret/a`);
  assert.match(r.content[0].text, /blocked by administrator/, 'block applies without restarting the instance');
  assert.match((await req(`${base}/hop`)).content[0].text, /blocked/, 'redirect hop into a blocked URL is refused');

  const { rows } = await act('requests', { since: 0 }) as any;
  assert.deepEqual(rows.map((x: any) => [x.url.replace(base, ''), x.status, x.blocked ? 'B' : '']),
    [['/secret/x', null, 'B'], ['/hop', 302, ''], ['/secret/a', null, 'B'], ['/secret/a', 200, '']]);
  assert.equal((await act('requests', { since: 0, outcome: 'blocked' }) as any).rows.length, 2);

  const [b] = await act('blocks') as any[];
  await act('unblock', { id: b.id });
  assert.equal((await req(`${base}/secret/a`)).isError, false, 'unblocked');
  inst.stop?.(); site.close();
});
