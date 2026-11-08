/**
 * Live SSH tests against a throwaway sshd. Skipped unless MCONTROLPROGRAM_TEST_SSH_PORT and
 * MCONTROLPROGRAM_TEST_SSH_KEY are set (see scripts/test-sshd.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MCONTROLPROGRAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // runs each plugin's init(host)
{ // new installs default to ask; these tests exercise ssh, not the default policy
  const { plugins } = await import('../src/core/plugin-loader.js');
  for (const id of ['ssh', 'mcp']) await plugins.get(id)!.globalActions!.set_policy!.run({ policy: 'allow' }, {} as any);
}
const port = Number(process.env.MCONTROLPROGRAM_TEST_SSH_PORT);
const keyFile = process.env.MCONTROLPROGRAM_TEST_SSH_KEY;
const skip = !port || !keyFile ? 'set MCONTROLPROGRAM_TEST_SSH_PORT and MCONTROLPROGRAM_TEST_SSH_KEY' : false;

const mk = async (over: Record<string, unknown>) => {
  const ssh = (await import('../src/plugins/ssh/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  const inst = (await ssh.create({ instanceId: 'i', instanceName: 'ssh', serverId: 's', global: () => ({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'),
    config: { ...ssh.defaultConfig, hosts: ['box'], ...over },
    pluginConfig: { ...ssh.defaultGlobalConfig, hosts: [{ name: 'box', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key', privateKey: fs.readFileSync(keyFile!, 'utf8') }] } })) as any;
  await inst.start?.();
  const tool = (n: string) => inst.tools.find((t: any) => t.name === n);
  const ctx = (principal: string, sessionId = 'sess-' + principal) => ({ principal, sessionId, signal: new AbortController().signal, log: inst.log ?? { connection() {}, debug() {} } });
  return { inst, tool, ctx };
};

test('wizard actions: add_host generates a key, public_key matches, test_host works once installed', { skip }, async () => {
  const ssh = (await import('../src/plugins/ssh/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  let stored: any = { ...ssh.defaultGlobalConfig };
  const actx = { get config() { return stored; }, async setConfig(n: any) { stored = n; }, log: new ScopedLogger({}, () => 'off') };
  const added: any = await ssh.globalActions!.add_host!.run({ name: 'gen', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key', keySource: 'generate', keyType: 'ed25519' }, actx);
  assert.match(added.publicKey, /^ssh-ed25519 AAAA/);
  assert.match(added.oneLiner, /authorized_keys/);
  assert.ok(stored.hosts[0].privateKey.includes('PRIVATE KEY'), 'private key stored server-side');
  assert.equal((await ssh.globalActions!.public_key!.run({ name: 'gen' }, actx) as any).publicKey, added.publicKey);
  await assert.rejects(ssh.globalActions!.test_host!.run({ name: 'gen' }, actx), /authentication/i, 'not installed yet');
  const ak = process.env.MCONTROLPROGRAM_TEST_SSH_AUTHORIZED_KEYS!;
  fs.appendFileSync(ak, added.publicKey + '\n');
  assert.equal((await ssh.globalActions!.test_host!.run({ name: 'gen' }, actx) as any).ok, true, 'key login works after install');
  const manual: any = await ssh.globalActions!.add_host!.run({ name: 'man', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key', keySource: 'manual', privateKey: fs.readFileSync(keyFile!, 'utf8') }, actx);
  assert.match(manual.publicKey, /^ssh-ed25519 /);
  await assert.rejects(ssh.globalActions!.add_host!.run({ name: 'man', host: 'x', username: 'u', auth: 'password', password: 'p' }, actx), /already exists/);
  await ssh.globalActions!.remove_host!.run({ name: 'man' }, actx);
  assert.deepEqual(stored.hosts.map((h: any) => h.name), ['gen']);
});

test('exec + sftp roundtrip', { skip }, async () => {
  const { inst, tool, ctx } = await mk({});
  const r = await tool('exec').handler({ host: 'box', command: 'echo hi; exit 3' }, ctx('a'));
  assert.ok(r.isError); assert.match(r.content[0].text, /hi[\s\S]*\[exit 3\]/);
  const f = `/tmp/mcontrolprogram-test-${process.pid}.txt`;
  assert.ok(!(await tool('sftp_write').handler({ host: 'box', path: f, content: 'data' }, ctx('a'))).isError);
  assert.equal((await tool('sftp_read').handler({ host: 'box', path: f }, ctx('a'))).content[0].text, 'data');
  fs.rmSync(f, { force: true });
  await inst.stop();
});

test('shellScope=principal isolates agents, resumes across sessions', { skip }, async () => {
  const { inst, tool, ctx } = await mk({ shellScope: 'principal' });
  const a = ctx('token:A', 's1'), b = ctx('token:B', 's2');
  const out = await tool('shell_send').handler({ host: 'box', input: 'export MARK=alpha; cd /tmp' }, a);
  assert.match(out.content[0].text, /\[shell default opened\]/);
  // B gets its own shell: no MARK, different cwd
  const bOut = await tool('shell_send').handler({ host: 'box', input: 'echo "M=$MARK"; pwd' }, b);
  assert.match(bOut.content[0].text, /\[shell default opened\]/);
  assert.match(bOut.content[0].text, /M=\n/);
  // A's state is intact, even from a new MCP session with the same principal
  const a2 = ctx('token:A', 's99');
  const aOut = await tool('shell_send').handler({ host: 'box', input: 'echo "M=$MARK"; pwd' }, a2);
  assert.doesNotMatch(aOut.content[0].text, /opened/);
  assert.match(aOut.content[0].text, /M=alpha/); assert.match(aOut.content[0].text, /\/tmp/);
  // B cannot list or close A's shell
  assert.match((await tool('shell_list').handler({}, b)).content[0].text, /^box\/default/);
  assert.match((await tool('shell_close').handler({ host: 'box', name: 'default' }, b)).content[0].text, /closed box\/default/);
  assert.match((await tool('shell_close').handler({ host: 'box', name: 'default' }, b)).content[0].text, /not open/);
  assert.match((await tool('shell_list').handler({}, a)).content[0].text, /^box\/default/, 'A still has its shell after B closed theirs');
  await inst.stop();
});

test('shellScope=session dies with the MCP session; shared is visible to all', { skip }, async () => {
  let { inst, tool, ctx } = await mk({ shellScope: 'session' });
  await tool('shell_send').handler({ host: 'box', input: 'true' }, ctx('A', 's1'));
  assert.match((await tool('shell_list').handler({}, ctx('A', 's2'))).content[0].text, /no open shells/, 'different session, same principal: not visible');
  await inst.onSessionClosed('s1');
  assert.match((await tool('shell_list').handler({}, ctx('A', 's1'))).content[0].text, /no open shells/);
  await inst.stop();
  ({ inst, tool, ctx } = await mk({ shellScope: 'shared' }));
  await tool('shell_send').handler({ host: 'box', input: 'true' }, ctx('A'));
  assert.match((await tool('shell_list').handler({}, ctx('B'))).content[0].text, /^box\/default/);
  await inst.stop();
});

test('reaper closes idle shells and connections, but output keeps a shell alive', { skip }, async () => {
  const { inst, tool, ctx } = await mk({ shellIdleSec: 3, idleDisconnectSec: 4 });
  // "busy" prints every second for 20s: no input, but output -> must survive the reaper tick
  await tool('shell_send').handler({ host: 'box', name: 'busy', input: 'for i in $(seq 20); do echo tick$i; sleep 1; done', waitMs: 500 }, ctx('A'));
  await tool('shell_send').handler({ host: 'box', name: 'quiet', input: 'true' }, ctx('A'));
  assert.equal(Object.keys((await inst.status()).connections).length, 1);
  await new Promise((r) => setTimeout(r, 16_500)); // one reaper tick (15s interval)
  const list = (await tool('shell_list').handler({}, ctx('A'))).content[0].text;
  assert.match(list, /box\/busy/, 'busy shell kept alive by its output');
  assert.doesNotMatch(list, /box\/quiet/, 'quiet shell reaped');
  const out = (await tool('shell_read').handler({ host: 'box', name: 'busy' }, ctx('A'))).content[0].text;
  assert.match(out, /tick1[0-9]/, 'output from the still-running job is readable');
  await tool('shell_close').handler({ host: 'box', name: 'busy' }, ctx('A'));
  await new Promise((r) => setTimeout(r, 16_500));
  assert.equal(Object.keys((await inst.status()).connections).length, 0, 'connection dropped once everything is idle');
  await inst.stop();
});

test('host key: test_host pins on first use, mismatch is refused, tunnel forwards and requires a pin', { skip }, async () => {
  const ssh = await import('../src/plugins/ssh/index.js');
  const { ScopedLogger } = await import('../src/core/logger.js');
  const net = await import('node:net');
  const log = new ScopedLogger({}, () => 'off');
  const box = { name: 'box', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key' as const, privateKey: fs.readFileSync(keyFile!, 'utf8') };
  let stored: any = { ...ssh.default.defaultGlobalConfig, hosts: [box] };
  const actx = { get config() { return stored; }, async setConfig(n: any) { stored = n; }, log };
  const r: any = await ssh.default.globalActions!.test_host!.run({ name: 'box' }, actx);
  assert.match(r.hostKey, /^SHA256:/); assert.ok(r.pinned);
  assert.equal(stored.hosts[0].hostKey, r.hostKey);
  await assert.rejects(ssh.default.globalActions!.test_host!.run({ name: 'box' }, { ...actx, config: { ...stored, hosts: [{ ...box, hostKey: 'SHA256:wrong' }] } }), /host key mismatch/);
  const g = { connectTimeoutMs: 5000, keepaliveSec: 30 };
  await assert.rejects(ssh.openTunnel(box, g, '127.0.0.1', 1, log), /no pinned host key/);
  const echo = net.createServer((s) => s.pipe(s)); await new Promise<void>((res) => echo.listen(0, '127.0.0.1', res));
  const t = await ssh.openTunnel(stored.hosts[0], g, '127.0.0.1', (echo.address() as any).port, log);
  for (let i = 0; i < 2; i++) { // two connections share one ssh session
    const got = await new Promise<string>((res, rej) => { const c = net.connect(t.port, '127.0.0.1', () => c.end('ping' + i)); let b = ''; c.on('data', (d) => (b += d)).on('end', () => res(b)).on('error', rej); });
    assert.equal(got, 'ping' + i);
  }
  t.close(); echo.close();
});

test('mcp plugin: http upstream reached through an ssh host (sshHost) with a pinned key', { skip }, async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const ssh2 = (await import('ssh2')).default;
  const { pluginConfig } = await import('../src/core/store.js');
  const { ScopedLogger } = await import('../src/core/logger.js');
  const { GLOBAL_DEFAULTS } = await import('../src/core/global-config.js');
  const { plugins } = await import('../src/core/plugin-loader.js');
  const mcp = plugins.get('mcp')!;
  // learn the test sshd's host key the way an admin would (first-use), then pin it
  const hostKey = await new Promise<string>((res, rej) => { const c = new ssh2.Client(); let fp = ''; c.on('ready', () => { c.end(); res(fp); }).on('error', rej)
    .connect({ host: '127.0.0.1', port, username: os.userInfo().username, privateKey: fs.readFileSync(keyFile!, 'utf8'), hostVerifier: (k: Buffer) => { fp = 'SHA256:' + createHash('sha256').update(k).digest('base64').replace(/=+$/, ''); return true; } }); });
  pluginConfig.savePlain('ssh', { connectTimeoutMs: 5000, keepaliveSec: 30, hosts: [{ name: 'box', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key', privateKey: fs.readFileSync(keyFile!, 'utf8'), hostKey }] });
  const UP = 7898;
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/echo-mcp.mjs');
  const up = spawn(process.execPath, [fixture, 'http', String(UP), 'tok'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((r) => up.stdout.on('data', (d) => d.toString().includes('ready') && r()));
    const servers = [{ name: 'remote', transport: 'http', url: `http://127.0.0.1:${UP}/mcp`, auth: 'bearer', token: 'tok', sshHost: 'box' }];
    const inst = await mcp.create({ instanceId: 'i', instanceName: 'mcp', serverId: 's', config: { ...mcp.defaultConfig, servers: ['remote'] }, pluginConfig: { servers, callTimeoutMs: 5000 }, global: () => GLOBAL_DEFAULTS, log: new ScopedLogger({}, () => 'off'), dep: () => undefined });
    await inst.start?.();
    const echo = inst.tools.find((t) => t.name === 'remote_echo')!;
    const r = await echo.handler({ text: 'via-ssh' }, { signal: new AbortController().signal, log: new ScopedLogger({}, () => 'off') } as any);
    assert.equal(r.content[0].type === 'text' && r.content[0].text, 'echo:via-ssh');
    await inst.stop?.();
    // wrong pin → refused
    pluginConfig.savePlain('ssh', { connectTimeoutMs: 5000, keepaliveSec: 30, hosts: [{ name: 'box', host: '127.0.0.1', port, username: os.userInfo().username, auth: 'key', privateKey: fs.readFileSync(keyFile!, 'utf8'), hostKey: 'SHA256:wrong' }] });
    await assert.rejects(mcp.globalActions!.test_server!.run({ name: 'remote' }, { config: { servers }, setConfig: async () => {}, log: new ScopedLogger({}, () => 'off'), dep: () => undefined }), /host key mismatch/);
  } finally { up.kill(); }
});
