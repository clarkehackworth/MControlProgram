import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-bp-'));
process.env.MCONTROLPROGRAM_DATA_DIR = data;
// drop-in plugins that depend on things, to exercise the loader
const pdir = path.join(data, 'plugins');
const mk = (id: string, version: string, deps: Record<string, string>) => {
  fs.mkdirSync(path.join(pdir, id), { recursive: true });
  fs.writeFileSync(path.join(pdir, id, 'index.mjs'), `export default { id: '${id}', name: '${id}', version: '${version}', description: '', configSchema: {}, dependencies: ${JSON.stringify(deps)}, api: { hi: () => '${id}' }, create: () => ({ tools: [] }) };`);
  fs.writeFileSync(path.join(pdir, id, 'package.json'), JSON.stringify({ name: id, main: 'index.mjs', type: 'module' }));
};
mk('dep-ok', '1.0.0', { ssh: '^0.2.0' });
mk('dep-bad', '1.0.0', { ssh: '^9.0.0' });
mk('dep-missing', '1.0.0', { nope: '*' });
mk('dep-chain', '1.0.0', { 'dep-bad': '*' });

const { satisfies } = await import('../src/core/semver.js');
const { loadPlugins, plugins, depResolver } = await import('../src/core/plugin-loader.js');
const { extensionId, parseStatus, sp } = await import('../src/plugins/browserpaw/index.js');

test('semver ranges', () => {
  assert.ok(satisfies('0.2.0', '^0.2.0'));
  assert.ok(satisfies('0.2.5', '^0.2.0'));
  assert.ok(!satisfies('0.3.0', '^0.2.0'));
  assert.ok(satisfies('1.4.0', '^1.2.0'));
  assert.ok(!satisfies('2.0.0', '^1.2.0'));
  assert.ok(satisfies('1.2.9', '~1.2.0') && !satisfies('1.3.0', '~1.2.0'));
  assert.ok(satisfies('1.5.0', '>=1.2.0 <2.0.0') && !satisfies('2.0.0', '>=1.2.0 <2.0.0'));
  assert.ok(satisfies('3.0.0', '^1.0.0 || ^3.0.0'));
  assert.ok(satisfies('0.0.1', '*') && satisfies('1.2.3', '1.2.3') && !satisfies('1.2.4', '1.2.3'));
});

test('loader drops plugins with unmet dependencies (transitively), resolves api', async () => {
  const r = await loadPlugins();
  const ids = plugins.list().map((p) => p.id);
  assert.ok(ids.includes('dep-ok') && ids.includes('browserpaw') && ids.includes('ssh'));
  for (const id of ['dep-bad', 'dep-missing', 'dep-chain']) assert.ok(!ids.includes(id), id);
  assert.ok(r.errors.some((e) => /dep-bad: unmet dependencies: ssh \^9\.0\.0 \(found 0\.2\.0\)/.test(e)));
  assert.ok(r.errors.some((e) => /dep-missing: .*nope \* \(not loaded\)/.test(e)));
  assert.ok(r.errors.some((e) => /dep-chain: .*dep-bad/.test(e)));
  const dep = depResolver(plugins.get('browserpaw')!);
  assert.equal(typeof dep('ssh').openTunnel, 'function');
  assert.throws(() => dep('web'), /did not declare/);
});

test('extension id matches Chrome (unpacked, from path)', () => {
  // the real id of the BrowserPaw extension loaded from this path on the dev box
  assert.equal(extensionId('/home/jeff/Downloads/chrome-mv3'), 'iigkegdahdmlbokglpdkgenigodfdnca');
  assert.match(extensionId('/x', Buffer.from('somekey').toString('base64')), /^[a-p]{32}$/);
});

test('shell path quoting keeps ~ expandable and everything else literal', () => {
  assert.equal(sp('~/a b'), `"$HOME"/'a b'`);
  assert.equal(sp("/x/it's"), `'/x/it'\\''s'`);
});

test('parseStatus finds the bridge port from ss, tied to the profile chromium by process tree', () => {
  const dir = '/home/u/.local/share/mcp-bp/work';
  const tok = 'ab'.repeat(32);
  const out = [
    `dir=${dir}`,
    `  100     1 /usr/lib/chromium/chromium --user-data-dir=${dir} --load-extension=/e about:blank`,
    `  101   100 /usr/lib/chromium/chromium --type=renderer --user-data-dir=${dir}`,
    `  200   100 /bin/sh ${dir}/browserpaw-host.sh chrome-extension://abc/`,
    `  201   200 node /bp/index.js chrome-extension://abc/`,
    `  300     1 /usr/lib/chromium/chromium --user-data-dir=${dir}-other`,
    `  301   300 node /bp/index.js chrome-extension://abc/`,
    '@@SS@@',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
    'LISTEN 0      511        127.0.0.1:12306      0.0.0.0:*    users:(("node",pid=301,fd=21))',
    'LISTEN 0      511        127.0.0.1:12307      0.0.0.0:*    users:(("node",pid=201,fd=21))',
    '@@TOKEN@@',
    tok,
  ].join('\n');
  assert.deepEqual(parseStatus(out), { dir, chromiumPid: 100, bridge: { pid: 201, port: 12307, token: tok } });
  assert.deepEqual(parseStatus(out.replace(tok, 'garbage')), { dir, chromiumPid: 100 });
  assert.deepEqual(parseStatus(`dir=${dir}\n  300 1 chromium --user-data-dir=${dir}-other\n@@SS@@\n\n@@TOKEN@@\n`), { dir });
  assert.deepEqual(parseStatus(''), {});
});
