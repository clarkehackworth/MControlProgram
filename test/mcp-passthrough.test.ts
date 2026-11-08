import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-mcp-'));
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // runs each plugin's init(host)
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/echo-mcp.mjs');
const { default: plugin } = await import('../src/plugins/mcp/index.js');
const { ScopedLogger } = await import('../src/core/logger.js');
// new installs default to ask; these tests exercise pass-through, not the default
await plugin.globalActions!.set_policy!.run({ policy: 'allow' }, {} as any);
const { GLOBAL_DEFAULTS } = await import('../src/core/global-config.js');

const PORT = 7899, TOKEN = 'sekrit';
const up = spawn(process.execPath, [fixture, 'http', String(PORT), TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((r) => up.stdout.on('data', (d) => d.toString().includes('ready') && r()));
after(() => { up.kill(); setTimeout(() => process.exit(0), 200).unref(); });

const servers = [
  { name: 'up', transport: 'http', url: `http://127.0.0.1:${PORT}/mcp`, auth: 'bearer', token: TOKEN },
  { name: 'local', transport: 'stdio', command: process.execPath, args: fixture, env: 'UPSTREAM_SECRET=from-mcontrolprogram' },
];
const make = async (config: Record<string, any>) => {
  const inst = await plugin.create({ instanceId: 'i', instanceName: 'mcp', serverId: 's', config: { ...plugin.defaultConfig, ...config }, pluginConfig: { servers, callTimeoutMs: 5000 }, global: () => GLOBAL_DEFAULTS, log: new ScopedLogger({ category: 'test' }) });
  await inst.start?.();
  return inst;
};
const ctx = { signal: new AbortController().signal, log: new ScopedLogger({ category: 'test' }) } as any;

test('http upstream with bearer: tools, schema and annotations pass through; calls proxied', async () => {
  const inst = await make({ servers: ['up'] });
  const names = inst.tools.map((t) => t.name);
  assert.deepEqual(names, ['up_echo', 'up_write_thing', 'up_secret_env']);
  const echo = inst.tools[0];
  assert.equal(echo.jsonSchema?.properties?.text?.description, 'What to echo');
  assert.equal(echo.annotations?.readOnlyHint, true);
  assert.equal(inst.tools[1].annotations?.readOnlyHint, undefined);
  const r = await echo.handler({ text: 'hi' }, ctx);
  assert.equal(r.content[0].type === 'text' && r.content[0].text, 'echo:hi');
  await inst.stop?.();
});

test('stdio upstream gets env from mcontrolprogram; flat names; allow/deny', async () => {
  const inst = await make({ servers: ['local'], flat: true, denyTools: ['write_thing'] });
  assert.deepEqual(inst.tools.map((t) => t.name), ['echo', 'secret_env']);
  const r = await inst.tools[1].handler({}, ctx);
  assert.equal(r.content[0].type === 'text' && r.content[0].text, 'from-mcontrolprogram');
  await inst.stop?.();
  const inst2 = await make({ servers: ['local'], allowTools: ['local/echo'] });
  assert.deepEqual(inst2.tools.map((t) => t.name), ['local_echo']);
  await inst2.stop?.();
});

test('wrong token: no tools, no throw', async () => {
  const inst = await plugin.create({ instanceId: 'i', instanceName: 'mcp', serverId: 's', config: { ...plugin.defaultConfig, servers: ['bad'] }, pluginConfig: { servers: [{ ...servers[0], name: 'bad', token: 'nope' }], callTimeoutMs: 5000 }, global: () => GLOBAL_DEFAULTS, log: new ScopedLogger({ category: 'test' }) });
  await inst.start?.();
  assert.equal(inst.tools.length, 0);
  await inst.stop?.();
});

test('test_server action lists upstream tools', async () => {
  const r: any = await plugin.globalActions!.test_server.run({ name: 'up' }, { config: { servers }, setConfig: async () => {}, log: new ScopedLogger({ category: 'test' }) });
  assert.equal(r.ok, true); assert.deepEqual(r.tools, ['echo', 'write_thing', 'secret_env']);
});
