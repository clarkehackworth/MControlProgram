import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-appr-'));
const { approvals } = await import('../src/core/approvals.js');
const { setGlobalConfig } = await import('../src/core/global-config.js');
setGlobalConfig({ approvalWaitSec: 1, approvalMaxAttempts: 3, approvalTtlSec: 60 });

const req = (args: any = { cmd: 'rm -rf /tmp/x' }) => ({ serverId: 's', instanceId: 'i', instanceName: 'ssh', pluginId: 'ssh', feature: 'tool', tool: 'ssh_exec', principal: 'token:a', args });

test('toolRule: explicit rules win over the mode; legacy list mode migrates to ask rules', async () => {
  const { normalizeApproval } = await import('../src/core/store.js');
  const ro = { name: 'list', description: '', annotations: { readOnlyHint: true }, handler: async () => ({ content: [] }) } as any;
  const rw = { name: 'exec', description: '', handler: async () => ({ content: [] }) } as any;
  assert.equal(approvals.toolRule({ mode: 'none' }, rw), 'allow');
  assert.equal(approvals.toolRule({ mode: 'writes' }, ro), 'allow');
  assert.equal(approvals.toolRule({ mode: 'writes' }, rw), 'ask');
  assert.equal(approvals.toolRule({ mode: 'all' }, ro), 'ask');
  assert.equal(approvals.toolRule({ mode: 'all', rules: { list: 'allow' } }, ro), 'allow');
  assert.equal(approvals.toolRule({ mode: 'none', rules: { exec: 'deny' } }, rw), 'deny');
  const legacy = normalizeApproval({ mode: 'list', tools: ['exec'] });
  assert.equal(approvals.toolRule(legacy, rw), 'ask');
  assert.equal(approvals.toolRule(legacy, ro), 'allow');
});

test('plugin asks: recorded with feature/summary/subject, filtered by plugin, keyed by subject not args', async () => {
  const ask = (subject: any, args: any) => approvals.gate({ ...req(args), pluginId: 'web', feature: 'url', tool: 'web_request', summary: `GET ${subject.url}`, reason: 'default: ask', subject });
  assert.equal((await ask({ url: 'https://a/' }, { n: 1 })).ok, false);
  const r2 = await ask({ url: 'https://a/' }, { n: 2 }); // same subject, different args: a check-back
  assert.match((r2 as any).message, /attempt 2 of 3/);
  const [rec, ...rest] = approvals.list('pending', { plugin: 'web' });
  assert.equal(rest.length, 0);
  assert.equal(rec!.feature, 'url'); assert.equal(rec!.summary, 'GET https://a/'); assert.deepEqual(rec!.subject, { url: 'https://a/' });
  assert.equal(approvals.list('pending', { plugin: 'ssh' }).some((a) => a.plugin_id === 'web'), false);
  const p = ask({ url: 'https://a/' }, {});
  await new Promise((r) => setTimeout(r, 50));
  approvals.decide(rec!.id, 'approved', 'jeff');
  assert.deepEqual(await p, { ok: true, by: 'approved by jeff' });
});

test('pending → check back → pause after max attempts; same args never create a second request', async () => {
  const r1 = await approvals.gate(req());
  assert.equal((r1 as any).status, 'pending'); assert.match((r1 as any).message, /attempt 1 of 3/);
  const r2 = await approvals.gate(req({ cmd: 'rm -rf /tmp/x' }));
  assert.equal((r2 as any).status, 'pending'); assert.match((r2 as any).message, /attempt 2 of 3/);
  const r3 = await approvals.gate(req());
  assert.equal((r3 as any).status, 'paused'); assert.match((r3 as any).message, /PAUSE/);
  assert.equal(approvals.list('pending').length, 1);
  assert.equal(approvals.list('pending')[0].attempts, 3);
});

test('approve wakes the blocked call; approval is consumed once; different args = new request', async () => {
  const p = approvals.gate(req({ cmd: 'ls' }));
  await new Promise((r) => setTimeout(r, 50));
  const pend = approvals.list('pending').find((a) => a.args.cmd === 'ls')!;
  const t0 = Date.now();
  approvals.decide(pend.id, 'approved', 'jeff');
  assert.equal((await p).ok, true);
  assert.ok(Date.now() - t0 < 500, 'woke immediately, not at deadline');
  // calling again with same args starts a fresh request (the approval was used)
  const again = await approvals.gate(req({ cmd: 'ls' }));
  assert.equal((again as any).status, 'pending'); assert.match((again as any).message, /attempt 1 of 3/);
});

test('deny and expire', async () => {
  const p = approvals.gate(req({ cmd: 'whoami' }));
  await new Promise((r) => setTimeout(r, 50));
  const pend = approvals.list('pending').find((a) => a.args.cmd === 'whoami')!;
  approvals.decide(pend.id, 'denied', 'jeff');
  assert.equal((await p as any).status, 'denied');
  assert.throws(() => approvals.decide(pend.id, 'approved', 'jeff'), /not pending/);
  assert.equal((await approvals.gate(req({ cmd: 'whoami' })) as any).status, 'denied', 'identical retry stays denied');
  assert.ok(!approvals.list('pending').some((a) => a.args.cmd === 'whoami'), 'no new request created');
  approvals.reopen(pend.id, 'jeff');
  const back = await approvals.gate(req({ cmd: 'whoami' }));
  assert.match((back as any).message, /attempt 1 of 3/, 'undone denial: the retry checks back on the same request');
  assert.equal(approvals.list('pending').filter((a) => a.args.cmd === 'whoami').length, 1);
  approvals.decide(pend.id, 'approved', 'jeff');
  assert.equal((await approvals.gate(req({ cmd: 'whoami' }))).ok, true);
  assert.throws(() => approvals.reopen(pend.id, 'jeff'), /only an unexpired denial/);

  setGlobalConfig({ approvalTtlSec: 60 });
  const p2 = approvals.gate(req({ cmd: 'date' }));
  await new Promise((r) => setTimeout(r, 50));
  const { getDb } = await import('../src/core/db.js');
  getDb().prepare("UPDATE approvals SET expires_at=0 WHERE status='pending'").run();
  approvals.expire();
  assert.equal((await p2 as any).status, 'expired');
  assert.equal(approvals.list('pending').length, 0);
});
