import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const { default: plugin, hostPath, sandboxName, q } = await import('../src/plugins/sandbox/index.js');

const h = { name: 'box', workspaceRoots: ['/srv/work/', '/data'] };

test('hostPath confines to workspace roots', () => {
  assert.equal(hostPath(h, '/srv/work/a/../b/'), '/srv/work/b');
  assert.equal(hostPath(h, '/data'), '/data');
  assert.throws(() => hostPath(h, '/srv/work/../etc/passwd'), /outside/);
  assert.throws(() => hostPath(h, '/srv/workother'), /outside/);
  assert.throws(() => hostPath(h, 'rel/path'), /absolute/);
  assert.throws(() => hostPath(h, '/data/x:y'), /':'/);
  assert.throws(() => hostPath({ name: 'n', workspaceRoots: [] }, '/data'), /no workspace roots/);
});

test('sandbox names and quoting', () => {
  assert.equal(sandboxName('my-box.1'), 'my-box.1');
  for (const bad of ['a', '-x', 'a b', "a';rm", '../x']) assert.throws(() => sandboxName(bad));
  assert.equal(execFileSync('sh', ['-c', `printf %s ${q("it's $(x) `y`")}`]).toString(), "it's $(x) `y`");
});

test('tools build the right sbx commands', async () => {
  const cmds: string[] = [];
  const log = { connection() {}, info() {}, debug() {}, warn() {}, error() {} } as any;
  const inst = plugin.create!({
    config: { hosts: ['box'] }, pluginConfig: { hosts: [{ ...h, sshHost: 'ssh-box' }] }, log,
    dep: () => ({ exec: async (_host: string, cmd: string) => { cmds.push(cmd); return { stdout: '[]', stderr: '', code: 0 }; } }),
  } as any) as any;
  const call = { log, signal: new AbortController().signal };
  const t = (n: string) => inst.tools.find((x: any) => x.name === n);
  await t('create').handler({ agent: 'shell', name: 'sb1', workspaces: [{ path: '/data/p', readOnly: true }], publish: ['8080'], denyNetwork: [], memory: '4g' }, call);
  await t('exec').handler({ sandbox: 'sb1', command: 'echo "hi"; id' }, call);
  await t('copy').handler({ from: 'sb1:/workspace/out.txt', to: '/srv/work/out.txt' }, call);
  await t('network_allow').handler({ sandbox: 'sb1', resources: '*.github.com' }, call);
  await t('write_file').handler({ sandbox: 'sb1', path: '/tmp/a b', content: 'x' }, call);
  assert.deepEqual(cmds.slice(0, 4), [
    "sbx create --name 'sb1' --no-progress -p '8080' -m '4g' shell '/data/p:ro'",
    `sbx exec 'sb1' sh -c 'echo "hi"; id'`,
    "sbx cp 'sb1:/workspace/out.txt' '/srv/work/out.txt'",
    "sbx policy allow network --sandbox 'sb1' '*.github.com'",
  ]);
  assert.match(cmds[4], /^printf %s 'eA==' \| base64 -d \| sbx exec -i 'sb1' sh -c .* sh '\/tmp\/a b'$/);
  await assert.rejects(async () => t('copy').handler({ from: '/etc/passwd', to: 'sb1:/x' }, call), /outside/);
  await assert.rejects(async () => t('copy').handler({ from: 'sb1:/a', to: 'sb2:/b' }, call), /exactly one/);
});

test('native hosts run sbx locally, without ssh', async () => {
  const log = { connection() {}, info() {}, debug() {}, warn() {}, error() {} } as any;
  const inst = plugin.create!({
    config: { hosts: ['me'] }, pluginConfig: { hosts: [{ name: 'me', native: true, sbx: 'echo' }] }, log,
    dep: () => ({ exec: async () => { throw new Error('ssh used for a native host'); } }),
  } as any) as any;
  const call = { log, signal: new AbortController().signal };
  const r = await inst.tools.find((x: any) => x.name === 'exec').handler({ sandbox: 'sb1', command: "it's $HOME" }, call);
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "exec sb1 sh -c it's $HOME\n");
  const w = await inst.tools.find((x: any) => x.name === 'write_file').handler({ sandbox: 'sb1', path: '/a', content: 'x' }, call);
  assert.match(w.content[0].text, /^exec -i sb1 sh -c/);
});
