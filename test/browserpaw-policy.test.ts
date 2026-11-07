import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));

test('browser URL policy: scheme table matches the extension mirror', async () => {
  const { browserVerdict } = await import('../src/core/url-policy.js');
  const rules = [{ action: 'block' as const, kind: 'domain' as const, value: 'evil.com' }, { action: 'allow' as const, kind: 'domain' as const, value: 'ok.com' }];
  const v = (u: string, top = true) => browserVerdict(u, rules, 'deny', top, 'selfid');
  assert.equal(v('https://x.ok.com/').allowedBy, 'domain: ok.com');
  assert.equal(v('https://evil.com./').blocked, 'domain: evil.com');
  assert.equal(v('wss://ok.com/').allowedBy, 'domain: ok.com');
  for (const u of ['file:///etc/passwd', 'ftp://ok.com/', 'ssh://h', 'javascript:alert(1)', 'chrome://settings/', 'vscode://x', 'chrome-extension://other/x'])
    assert.ok(v(u).blocked, u);
  assert.equal(v('view-source:file:///etc/passwd').blocked, 'scheme: file:');
  assert.equal(v('blob:https://evil.com/x').blocked, 'domain: evil.com');
  assert.equal(v('blob:https://ok.com/x').allowedBy, 'domain: ok.com');
  assert.ok(v('data:text/html,x').blocked); assert.ok(!v('data:image/png,x', false).blocked);
  assert.ok(!v('about:blank').blocked && !v('chrome://newtab/').blocked && !v('chrome-extension://selfid/p.html').blocked);
});

test('browser URL policy: separate list, RE2 check, push/fail closed, pre-check, attribution, event pull', async () => {
  const policy = await import('../src/plugins/browserpaw/policy.js');
  const web = await import('../src/core/url-policy.js');
  const act = (k: string, p: any = {}) => (policy.actions as any)[k].run(p);

  await act('rule', { action: 'block', kind: 'domain', value: 'evil.com' });
  assert.equal(web.ruleStore('web').rules().length, 0, 'browser list is separate from the web plugin list');
  await assert.rejects(act('rule', { action: 'block', kind: 'regex', value: 'a(?=b)' }), /RE2/);

  // fake bridge
  let ext = { rev: null as number | null, rules: [] as any[], events: [] as any[], epoch: 'e1', up: true };
  const call = async (method: string, p: string, body?: any) => {
    if (!ext.up) throw new Error('ECONNREFUSED');
    if (method === 'PUT' && p === '/url-policy') { ext.rev = body.rev; ext.rules = body.rules; return { status: 'success', rev: body.rev, installed: body.rules.length, rejected: [] }; }
    if (p.startsWith('/url-policy/events')) {
      const after = Number(new URL(p, 'http://x').searchParams.get('after'));
      ext.events = ext.events.filter((e) => e.seq > after);
      return { status: 'success', epoch: ext.epoch, rev: ext.rev, events: ext.events, dropped: 0 };
    }
    throw new Error('unexpected ' + p);
  };

  await policy.ensureSynced('p1', call as any);
  assert.equal(ext.rev, policy.store.rev());
  assert.deepEqual(ext.rules.map((r) => r.value), ['evil.com']);

  // a change while the browser is unreachable → out of sync → calls refused
  ext.up = false;
  await act('rule', { action: 'block', kind: 'domain', value: 'bad.org' });
  await assert.rejects(policy.ensureSynced('p1', call as any), /refused until it is/);
  assert.equal(policy.syncStatus().p1!.inSync, false);
  ext.up = true;
  await policy.ensureSynced('p1', call as any);
  assert.equal(policy.syncStatus().p1!.inSync, true);

  // tool-arg pre-check + caller stamp (agent-supplied _meta discarded)
  const who = { principal: 'alice', sessionId: 's1' };
  await assert.rejects(() => policy.prepareCall('p1', 'chrome_navigate', { url: 'https://evil.com/' }, who), /blocked by administrator \(domain: evil.com\)/);
  await assert.rejects(() => policy.prepareCall('p1', 'chrome_navigate', { url: 'file:///etc/passwd' }, who), /scheme: file:/);
  await assert.rejects(() => policy.prepareCall('p1', 'chrome_batch_actions', { steps: [{ action: 'navigate', url: 'ssh://x' }] }, who), /scheme: ssh:/);
  const ok = await policy.prepareCall('p1', 'chrome_navigate', { url: 'back', _meta: { mcp: { principal: 'mallory' } } }, who);
  assert.deepEqual(ok, { url: 'back', _meta: { mcp: { principal: 'alice', sessionId: 's1' } } });

  // events pulled into the log with attribution; extension rev reset (restart w/o storage) triggers re-push
  ext.events = [
    { seq: 1, ts: Date.now() + 1000, tabId: 7, type: 'sub_frame', method: 'GET', url: 'https://evil.com/f', blocked: 'domain: evil.com', via: 'dnr', principal: 'alice', sessionId: 's1', agentVia: 'inherited' },
    { seq: 2, ts: Date.now() + 2000, tabId: 3, type: 'main_frame', method: 'GET', url: 'https://ok.com/', allowedBy: 'default: allow', via: 'observed' },
  ];
  ext.rev = 0;
  await policy.pull('p1', call as any);
  assert.equal(ext.rev, policy.store.rev(), 're-pushed after rev mismatch');
  const { rows } = await act('requests', { since: 0, until: Date.now() + 5000 });
  assert.deepEqual(rows.map((r: any) => [r.via, r.principal, r.agent_via, r.blocked ?? r.allowed_by]), [
    ['observed', null, null, 'default: allow'],
    ['dnr', 'alice', 'inherited', 'domain: evil.com'],
    ['tool-arg', 'alice', 'tool', 'scheme: ssh:'],
    ['tool-arg', 'alice', 'tool', 'scheme: file:'],
    ['tool-arg', 'alice', 'tool', 'domain: evil.com'],
  ]);
  await policy.pull('p1', call as any);
  assert.equal((await act('requests', { since: 0, until: Date.now() + 5000 })).rows.length, 5, 'events are not pulled twice');
});
