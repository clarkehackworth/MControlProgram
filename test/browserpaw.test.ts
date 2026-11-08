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
const { parseStatus, sp, pp, platforms, osFromUname } = await import('../src/plugins/browserpaw/platform.js');
const extensionId = platforms.linux.extensionId;

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
  assert.equal(typeof dep('web').ruleStore, 'function', 'declared dependency');
  assert.throws(() => dep('mcp'), /did not declare/);
  const mcpDep = depResolver(plugins.get('mcp')!);
  assert.equal(typeof mcpDep('ssh').openTunnel, 'function', 'optional dependency present');
  assert.equal(depResolver({ ...plugins.get('mcp')!, optionalDependencies: { ssh: '^9.0.0' } })('ssh'), undefined, 'optional dependency out of range');
  assert.equal(depResolver({ ...plugins.get('mcp')!, optionalDependencies: { gone: '*' } })('gone'), undefined, 'optional dependency missing');
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
  // The bridge's own children (e.g. the local Jev decider on 8009) also descend from chromium: skip them.
  const decider = '    LISTEN 0      2048       127.0.0.1:8009       0.0.0.0:*    users:(("python3",pid=202,fd=7))';
  const withDecider = out.replace(`  201   200 node`, `  202   201 python3 -m uvicorn decider.serve:app\n  201   200 node`).replace('@@SS@@\n', `@@SS@@\n${decider.trim()}\n`);
  assert.deepEqual(parseStatus(withDecider), { dir, chromiumPid: 100, bridge: { pid: 201, port: 12307, token: tok } });
});

test('plugin config schema patterns reject bad profile names (same rule the UI enforces)', async () => {
  const { default: bp } = await import('../src/plugins/browserpaw/index.js');
  const pattern = (bp.globalConfigSchema as any).properties.profiles.items.properties.name.pattern;
  assert.ok(new RegExp(pattern).test('Kali_profile-1'));
  assert.ok(!new RegExp(pattern).test('Kali profile 1'));
});

test('parseStatus: macOS lsof and Windows (quoted command line, synthesized socket lines)', () => {
  const tok = 'cd'.repeat(32);
  const mac = '/Users/u/Library/Application Support/mcp-bp/work';
  const macOut = [
    `dir=${mac}`,
    `  500     1 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${mac} --load-extension=/e about:blank`,
    `  510   500 /bin/sh ${mac}/browserpaw-host.sh chrome-extension://abc/`,
    `  511   510 node /bp/index.js chrome-extension://abc/`,
    '@@SS@@',
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node      999 u     21u  IPv4 0x1234      0t0  TCP 127.0.0.1:12306 (LISTEN)',
    'node      511 u     21u  IPv4 0x5678      0t0  TCP 127.0.0.1:12309 (LISTEN)',
    '@@TOKEN@@', tok,
  ].join('\n');
  assert.deepEqual(parseStatus(macOut), { dir: mac, chromiumPid: 500, bridge: { pid: 511, port: 12309, token: tok } });
  const win = 'C:\\Users\\Jo Smith\\AppData\\Local\\mcontrolprogram-browserpaw\\work';
  const winOut = [
    `dir=${win}`,
    `4000 3000 "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=${win}" --load-extension=C:\\bp\\ext about:blank`,
    `4001 4000 "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer "--user-data-dir=${win}"`,
    `4100 4000 C:\\Windows\\system32\\cmd.exe /d /s /c "C:\\bp\\run_host.bat chrome-extension://abc/"`,
    `4101 4100 "C:\\node\\node.exe" C:\\bp\\index.js chrome-extension://abc/`,
    '@@SS@@',
    'LISTEN 127.0.0.1:12306 pid=77',
    'LISTEN 127.0.0.1:12311 pid=4101',
    '@@TOKEN@@', tok,
  ].join('\n');
  assert.deepEqual(parseStatus(winOut), { dir: win, chromiumPid: 4000, bridge: { pid: 4101, port: 12311, token: tok } });
});

test('OS detection and Windows quoting helpers', () => {
  assert.equal(osFromUname('Linux\n'), 'linux');
  assert.equal(osFromUname('Darwin\n'), 'macos');
  assert.equal(osFromUname("'uname' is not recognized as an internal or external command"), undefined);
  assert.equal(pp('~/AppData/Local/x y'), "(Join-Path $HOME 'AppData\\Local\\x y')");
  assert.equal(pp("C:/it's"), "'C:\\it''s'");
  // the Windows id hashes UTF-16LE with an upper-case drive letter, so drive case must not matter
  assert.equal(platforms.windows.extensionId('c:\\bp\\ext'), platforms.windows.extensionId('C:\\bp\\ext'));
  assert.notEqual(platforms.windows.extensionId('C:\\bp\\ext'), platforms.linux.extensionId('C:\\bp\\ext'));
  const w = platforms.windows.launch({ dir: 'C:\\p\\a b', ext: 'C:\\e', extensionId: 'x', nativeHost: 'C:\\n.bat', chromium: 'C:\\Program Files\\c.exe' }, { browser: 'chrome', toolProfile: 'core', headless: false, extraArgs: '', env: [], task: 'T' });
  assert.match(w, /set "CHROME_MCP_TOOL_PROFILE=core"&& start "" "C:\\Program Files\\c\.exe" --user-data-dir="C:\\p\\a b" --load-extension=C:\\e/);
  assert.match(w, /--disable-features=DisableLoadExtensionCommandLineSwitch/);
  assert.match(platforms.windows.wrap('x'), /^powershell -NoProfile .* -EncodedCommand [A-Za-z0-9+/=]+$/);
});

test('POSIX scripts run under sh: inspect, setup, status (linux and macos variants)', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bp sh it's-"));
  fs.mkdirSync(path.join(root, 'bp/app/chrome-extension/.output/chrome-mv3'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bp/app/chrome-extension/.output/chrome-mv3/manifest.json'), '{"name":"x"}');
  fs.mkdirSync(path.join(root, 'bp/app/native-server/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bp/app/native-server/dist/run_host.sh'), '#!/bin/sh\n');
  for (const name of ['linux', 'macos'] as const) {
    const pf = platforms[name];
    const sh = (script: string) => execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: root } }).toString();
    const o = Object.fromEntries(sh(pf.inspect({ ext: '~/bp/app/chrome-extension/.output/chrome-mv3', nativeHost: `~/bp/${pf.nativeHostRel}`, chromium: '/bin/sh', profile: `~/profiles/${name}` })).trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(o.ext, fs.realpathSync(path.join(root, 'bp/app/chrome-extension/.output/chrome-mv3')));
    assert.equal(JSON.parse(Buffer.from(o.manifest!, 'base64').toString()).name, 'x');
    assert.equal(o.nativehost, fs.realpathSync(path.join(root, 'bp/app/native-server/dist/run_host.sh')));
    assert.equal(o.chromium, '/bin/sh');
    assert.equal(o.dir, fs.realpathSync(path.join(root, 'profiles', name)));
    const r = { dir: o.dir!, ext: o.ext!, extensionId: pf.extensionId(o.ext!), nativeHost: o.nativehost!, chromium: o.chromium! };
    assert.match(sh(pf.setup(r, name, 'chromium', 'crawl')), /done=1/);
    const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'NativeMessagingHosts/com.chromemcp.nativehost.json'), 'utf8'));
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${r.extensionId}/`]);
    assert.equal(m.path, `${r.dir}/browserpaw-host.sh`);
    assert.match(fs.readFileSync(m.path, 'utf8'), /CHROME_MCP_TOOL_PROFILE='crawl'\nexec '.*run_host\.sh' "\$@"/);
    assert.equal(fs.statSync(m.path).mode & 0o777, 0o700);
    const st = parseStatus(sh(pf.status(`~/profiles/${name}`)));
    assert.equal(st.dir, r.dir); assert.equal(st.chromiumPid, undefined); // nothing running
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('proxy settings become chromium flags, quoted per OS', async () => {
  const r = { dir: '/p', ext: '/e', extensionId: 'x', nativeHost: '/n', chromium: '/c' };
  const base = { browser: 'chromium' as const, toolProfile: 'full', headless: false, extraArgs: '', env: [] as [string, string][], task: 'T' };
  const l = platforms.linux.launch(r, { ...base, proxy: 'socks5://10.0.0.5:1080', proxyBypass: '*.lan;192.168.0.0/16' });
  assert.match(l, /'--proxy-server=socks5:\/\/10\.0\.0\.5:1080' '--proxy-bypass-list=\*\.lan;192\.168\.0\.0\/16'/);
  assert.doesNotMatch(platforms.linux.launch(r, { ...base, proxyBypass: '*.lan' }), /proxy/); // bypass alone is meaningless
  const w = platforms.windows.launch({ ...r, dir: 'C:\\p', ext: 'C:\\e', chromium: 'C:\\c.exe' }, { ...base, proxy: 'http=p1:3128;https=p2:3128' });
  assert.match(w, /--proxy-server=http=p1:3128;https=p2:3128/);
  const { default: bp } = await import('../src/plugins/browserpaw/index.js');
  const s = (bp.globalConfigSchema as any).properties.profiles.items.properties.proxy.pattern;
  assert.ok(new RegExp(s).test('socks5://h:1080') && !new RegExp(s).test('http://user:pw@h:3128') && !new RegExp(s).test("x' && rm -rf ~"));
});

test('browserpaw instance supplies usage instructions with a {prefix} placeholder', async () => {
  const p = plugins.get('browserpaw')!;
  const inst = await p.create({ instanceId: 'i', instanceName: 'bp', serverId: 's', config: { profiles: [] }, pluginConfig: { hosts: [], profiles: [] }, global: () => ({}) as any, log: { debug() {}, info() {}, warn() {}, error() {} } as any, dep: depResolver(p) });
  assert.match(inst.instructions ?? '', /\{prefix\}_profiles/);
});
