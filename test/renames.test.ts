import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));
const { loadPlugins, plugins } = await import('../src/core/plugin-loader.js');
const { servers, instances, pluginConfig, propagateRenames } = await import('../src/core/store.js');
const cmdRules = await import('../src/plugins/ssh/rules.js');

test('renaming an inventory item rewrites references everywhere', async () => {
  await loadPlugins();
  const srv = servers.create({ name: 't', port: 47999 });
  pluginConfig.savePlain('ssh', { hosts: [{ name: 'box', host: 'h', username: 'u', auth: 'native' }, { name: 'other', host: 'o', username: 'u', auth: 'native' }] });
  pluginConfig.savePlain('browserpaw', { hosts: [{ name: 'bh', sshHost: 'box' }], profiles: [{ name: 'Kali profile 1', host: 'bh' }, { name: 'p2', host: 'bh' }] });
  const ssh = instances.create(srv.id, 'ssh', 'ssh', { hosts: ['box', 'other'], hostsDisabled: ['box'] });
  const bp = instances.create(srv.id, 'browserpaw', 'browserpaw', { profiles: ['Kali profile 1', 'p2'] });
  await cmdRules.actions.rule.run({ action: 'block', kind: 'program', value: 'rm', host: 'box' });

  // browserpaw: rename a profile and a host in one save; the profile's host ref (same plugin) follows too
  const body = { hosts: [{ name: 'bh2', sshHost: 'box' }], profiles: [{ name: 'Kali-profile1', host: 'bh' }, { name: 'p2', host: 'bh' }] };
  const r = propagateRenames('browserpaw', pluginConfig.raw('browserpaw'), body);
  assert.deepEqual(r.renames.map((x) => `${x.key}:${x.from}>${x.to}`).sort(), ['hosts:bh>bh2', 'profiles:Kali profile 1>Kali-profile1']);
  assert.deepEqual(body.profiles.map((p) => p.host), ['bh2', 'bh2']);
  assert.deepEqual(instances.get(bp.id)!.config.profiles, ['Kali-profile1', 'p2']);
  pluginConfig.saveFromUi('browserpaw', body);

  // ssh host rename reaches the ssh instance (incl. disabled list), browserpaw's sshHost (other plugin), and host-scoped rules
  const sbody = { ...pluginConfig.raw('ssh'), hosts: [{ name: 'box2', host: 'h', username: 'u', auth: 'native' }, { name: 'other', host: 'o', username: 'u', auth: 'native' }] };
  const r2 = propagateRenames('ssh', pluginConfig.raw('ssh'), sbody);
  for (const x of r2.renames) plugins.get('ssh')!.onRenamed?.(x.key, x.from, x.to);
  assert.deepEqual([...r2.touchedPlugins], ['browserpaw']);
  assert.deepEqual(instances.get(ssh.id)!.config.hosts, ['box2', 'other']);
  assert.deepEqual(instances.get(ssh.id)!.config.hostsDisabled, ['box2']);
  assert.equal(pluginConfig.raw('browserpaw').hosts[0].sshHost, 'box2');
  assert.deepEqual(cmdRules.rules().map((x) => x.host), ['box2']);

  // swaps, adds and deletes are not renames
  assert.equal(propagateRenames('ssh', { hosts: [{ name: 'a' }, { name: 'b' }] }, { hosts: [{ name: 'b' }, { name: 'a' }] }).renames.length, 0);
  assert.equal(propagateRenames('ssh', { hosts: [{ name: 'a' }] }, { hosts: [{ name: 'a' }, { name: 'b' }] }).renames.length, 0);
});
