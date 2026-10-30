import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-appr-'));
const { approvals } = await import('../src/core/approvals.js');
const { setGlobalConfig } = await import('../src/core/global-config.js');
setGlobalConfig({ approvalWaitSec: 1, approvalMaxAttempts: 3, approvalTtlSec: 60 });

const req = (args: any = { cmd: 'rm -rf /tmp/x' }) => ({ serverId: 's', instanceId: 'i', instanceName: 'ssh', tool: 'ssh_exec', principal: 'token:a', args });

test('needsApproval honours policy modes', () => {
  const ro = { name: 'list', description: '', annotations: { readOnlyHint: true }, handler: async () => ({ content: [] }) } as any;
  const rw = { name: 'exec', description: '', handler: async () => ({ content: [] }) } as any;
  assert.equal(approvals.needsApproval({ mode: 'none' }, rw), false);
  assert.equal(approvals.needsApproval({ mode: 'writes' }, ro), false);
  assert.equal(approvals.needsApproval({ mode: 'writes' }, rw), true);
  assert.equal(approvals.needsApproval({ mode: 'all' }, ro), true);
  assert.equal(approvals.needsApproval({ mode: 'list', tools: ['exec'] }, rw), true);
  assert.equal(approvals.needsApproval({ mode: 'list', tools: ['exec'] }, ro), false);
});

test('pending → check back → pause after max attempts; same args never create a second request', async () => {
  const r1 = await approvals.gate(req());
  assert.equal(r1?.status, 'pending'); assert.match(r1!.message, /attempt 1 of 3/);
  const r2 = await approvals.gate(req({ cmd: 'rm -rf /tmp/x' }));
  assert.equal(r2?.status, 'pending'); assert.match(r2!.message, /attempt 2 of 3/);
  const r3 = await approvals.gate(req());
  assert.equal(r3?.status, 'paused'); assert.match(r3!.message, /PAUSE/);
  assert.equal(approvals.list('pending').length, 1);
  assert.equal(approvals.list('pending')[0].attempts, 3);
});

test('approve wakes the blocked call; approval is consumed once; different args = new request', async () => {
  const p = approvals.gate(req({ cmd: 'ls' }));
  await new Promise((r) => setTimeout(r, 50));
  const pend = approvals.list('pending').find((a) => a.args.cmd === 'ls')!;
  const t0 = Date.now();
  approvals.decide(pend.id, 'approved', 'jeff');
  assert.equal(await p, undefined);
  assert.ok(Date.now() - t0 < 500, 'woke immediately, not at deadline');
  // calling again with same args starts a fresh request (the approval was used)
  const again = await approvals.gate(req({ cmd: 'ls' }));
  assert.equal(again?.status, 'pending'); assert.match(again!.message, /attempt 1 of 3/);
});

test('deny and expire', async () => {
  const p = approvals.gate(req({ cmd: 'whoami' }));
  await new Promise((r) => setTimeout(r, 50));
  const pend = approvals.list('pending').find((a) => a.args.cmd === 'whoami')!;
  approvals.decide(pend.id, 'denied', 'jeff');
  assert.equal((await p)?.status, 'denied');
  assert.throws(() => approvals.decide(pend.id, 'approved', 'jeff'), /not pending/);
  assert.equal((await approvals.gate(req({ cmd: 'whoami' })))?.status, 'denied', 'identical retry stays denied');
  assert.ok(!approvals.list('pending').some((a) => a.args.cmd === 'whoami'), 'no new request created');

  setGlobalConfig({ approvalTtlSec: 60 });
  const p2 = approvals.gate(req({ cmd: 'date' }));
  await new Promise((r) => setTimeout(r, 50));
  const { getDb } = await import('../src/core/db.js');
  getDb().prepare("UPDATE approvals SET expires_at=0 WHERE status='pending'").run();
  approvals.expire();
  assert.equal((await p2)?.status, 'expired');
  assert.equal(approvals.list('pending').length, 0);
});
