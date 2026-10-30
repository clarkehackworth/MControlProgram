import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));

const { encrypt, decrypt, hashPassword, verifyPassword } = await import('../src/core/crypto.js');
const { encryptSecrets, decryptSecrets, redactSecrets, mergeSecrets, REDACTED } = await import('../src/core/secrets.js');

test('aes-gcm roundtrip and tamper detection', () => {
  const blob = encrypt('hello');
  assert.notEqual(blob, 'hello');
  assert.equal(decrypt(blob), 'hello');
  assert.throws(() => decrypt(blob.slice(0, -4) + 'AAAA'));
});

test('password hashing', () => {
  const h = hashPassword('s3cret');
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('wrong', h));
});

const schema = {
  type: 'object',
  properties: {
    hosts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, key: { type: 'string', 'x-secret': true } } } },
    token: { type: 'string', 'x-secret': true },
    plain: { type: 'string' },
  },
};

test('secrets: encrypt/decrypt/redact/merge walk the schema', () => {
  const cfg = { hosts: [{ name: 'a', key: 'KEY_A' }, { name: 'b', key: '' }], token: 'TOK', plain: 'visible' };
  const enc = encryptSecrets(cfg, schema) as any;
  assert.match(enc.hosts[0].key, /^enc:v1:/);
  assert.equal(enc.hosts[1].key, '');
  assert.match(enc.token, /^enc:v1:/);
  assert.equal(enc.plain, 'visible');
  assert.deepEqual(decryptSecrets(enc, schema), cfg);
  const red = redactSecrets(enc, schema) as any;
  assert.equal(red.hosts[0].key, REDACTED);
  assert.equal(red.token, REDACTED);
  assert.equal(red.plain, 'visible');
  // UI sends redacted placeholders back + one changed secret
  const incoming = { ...red, token: 'NEWTOK', hosts: [{ name: 'a', key: REDACTED }, { name: 'b', key: 'KEY_B' }] };
  const merged = mergeSecrets(incoming, enc, schema) as any;
  assert.equal(merged.hosts[0].key, enc.hosts[0].key);
  assert.equal(merged.hosts[1].key, 'KEY_B');
  assert.equal(merged.token, 'NEWTOK');
  assert.deepEqual(decryptSecrets(encryptSecrets(merged, schema), schema), { hosts: [{ name: 'a', key: 'KEY_A' }, { name: 'b', key: 'KEY_B' }], token: 'NEWTOK', plain: 'visible' });
});

test('store: bearer token verify, admin sessions, plugin instance secrets at rest', async () => {
  const { getDb } = await import('../src/core/db.js');
  const { servers, bearerTokens, admins, instances } = await import('../src/core/store.js');
  const { loadPlugins } = await import('../src/core/plugin-loader.js');
  await loadPlugins();
  const s = servers.create({ name: 't', port: 7999 });
  const { token } = bearerTokens.create(s.id, 'agent');
  assert.equal(bearerTokens.verify(s.id, token)?.name, 'agent');
  assert.equal(bearerTokens.verify(s.id, token + 'x'), undefined);
  assert.equal(bearerTokens.verify('other', token), undefined);
  admins.create('root', 'password123');
  const sid = admins.createSession(admins.get('root')!.id);
  assert.equal(admins.sessionUser(sid)?.username, 'root');
  const { pluginConfig } = await import('../src/core/store.js');
  pluginConfig.savePlain('web', { credentials: [{ name: 'x', urlPattern: '^https://x/', type: 'bearer', secret: 'SECRET' }] });
  const raw = getDb().prepare('SELECT config FROM plugin_config WHERE plugin_id=?').get('web') as any;
  assert.ok(!raw.config.includes('SECRET'), 'plugin-level secret must not be stored in plaintext');
  assert.equal((pluginConfig.decrypted('web') as any).credentials[0].secret, 'SECRET');
  assert.equal((pluginConfig.redacted('web') as any).credentials[0].secret, REDACTED);
  // UI round-trip keeps the stored secret when the placeholder comes back
  pluginConfig.saveFromUi('web', { credentials: [{ name: 'x', urlPattern: '^https://y/', type: 'bearer', secret: REDACTED }] });
  assert.equal((pluginConfig.decrypted('web') as any).credentials[0].secret, 'SECRET');
  assert.equal((pluginConfig.decrypted('web') as any).credentials[0].urlPattern, '^https://y/');
  const inst = instances.create(s.id, 'web', 'web', { credentials: ['x'] });
  assert.deepEqual((instances.decrypted(inst) as any).credentials, ['x']);
});

test('web plugin: url policy, private network block, html to text', async () => {
  const web = (await import('../src/plugins/web/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  const mk = (over: Record<string, unknown>) => web.create({ instanceId: 'i', instanceName: 'web', serverId: 's', global: () => ({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30 }),
    config: { ...web.defaultConfig, ...over }, pluginConfig: { credentials: [] }, log: new ScopedLogger({}, () => 'off') }) as any;
  const ctx = { signal: new AbortController().signal, log: new ScopedLogger({}, () => 'off') };
  const inst = await mk({ allowUrls: ['^https://allowed\\.example/'], denyUrls: ['secret'] });
  const req = inst.tools.find((t: any) => t.name === 'request');
  let r = await req.handler({ url: 'http://127.0.0.1:1/', method: 'GET' }, ctx);
  assert.ok(r.isError && /private network/.test(r.content[0].text));
  r = await req.handler({ url: 'https://allowed.example/secret', method: 'GET' }, ctx);
  assert.ok(r.isError && /denied/.test(r.content[0].text));
  r = await req.handler({ url: 'https://other.example/', method: 'GET' }, ctx);
  assert.ok(r.isError && /allow list/.test(r.content[0].text));
  r = await req.handler({ url: 'https://allowed.example/', method: 'TRACE' }, ctx);
  assert.ok(r.isError && /method/.test(r.content[0].text));
});

test('ssh plugin: command policy and sftp root confinement', async () => {
  const ssh = (await import('../src/plugins/ssh/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  const inst = await ssh.create({ instanceId: 'i', instanceName: 'ssh', serverId: 's', global: () => ({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'),
    config: { ...ssh.defaultConfig, hosts: ['h'] },
    pluginConfig: { ...ssh.defaultGlobalConfig, connectTimeoutMs: 100, hosts: [{ name: 'h', host: '192.0.2.1', username: 'u', auth: 'password', password: 'x', allowCommands: ['^ls', '^cat '], denyCommands: ['rm'], sftpRoot: '/srv/data' }, { name: 'hidden', host: '192.0.2.2', username: 'u', auth: 'agent' }] } }) as any;
  assert.deepEqual(JSON.parse((await inst.tools.find((t: any) => t.name === 'list_hosts').handler({}, {})).content[0].text).map((h: any) => h.name), ['h'], 'instance only exposes selected hosts');
  const ctx = { signal: new AbortController().signal, log: new ScopedLogger({}, () => 'off') };
  const exec = inst.tools.find((t: any) => t.name === 'exec');
  let r = await exec.handler({ host: 'h', command: 'rm -rf /' }, ctx);
  assert.ok(r.isError && /denied/.test(r.content[0].text));
  r = await exec.handler({ host: 'h', command: 'whoami' }, ctx);
  assert.ok(r.isError && /allow list/.test(r.content[0].text));
  r = await exec.handler({ host: 'nope', command: 'ls' }, ctx);
  assert.ok(r.isError && /unknown host/.test(r.content[0].text));
  const list = inst.tools.find((t: any) => t.name === 'sftp_list');
  // path escapes root -> rejected before any connection attempt
  r = await list.handler({ host: 'h', path: '/srv/data/../../etc' }, ctx);
  assert.ok(r.isError && /(outside sftp root|ECONNREFUSED|Timed out|connect)/.test(r.content[0].text), r.content[0].text);
  await inst.stop();
});

test('mergeSecrets matches array items by name, not index', () => {
  const schema = { type: 'object', properties: { hosts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, privateKey: { type: 'string', 'x-secret': true } } } } } };
  const stored = encryptSecrets({ hosts: [{ name: 'a', privateKey: 'KEY-A' }, { name: 'b', privateKey: 'KEY-B' }] }, schema) as any;
  // UI removed host "a" and left b's secret untouched (placeholder)
  const merged = mergeSecrets({ hosts: [{ name: 'b', privateKey: REDACTED }] }, stored, schema) as any;
  assert.equal(decrypt(merged.hosts[0].privateKey), 'KEY-B');
  // reorder + new host with a typed secret
  const m2 = mergeSecrets({ hosts: [{ name: 'c', privateKey: 'KEY-C' }, { name: 'a', privateKey: REDACTED }], }, stored, schema) as any;
  assert.equal(m2.hosts[0].privateKey, 'KEY-C'); assert.equal(decrypt(m2.hosts[1].privateKey), 'KEY-A');
});
