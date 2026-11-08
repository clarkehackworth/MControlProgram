import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-ask-'));
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // runs each plugin's init(host)

test('ask rules: precedence block > ask > allow > default, in URL and SSH engines', async () => {
  const { verdict } = await import('../src/plugins/web/url-policy.js');
  const L = [{ action: 'block' as const, kind: 'url' as const, value: 'https://a.com/x' }, { action: 'ask' as const, kind: 'domain' as const, value: 'a.com' }, { action: 'allow' as const, kind: 'domain' as const, value: 'b.a.com' }];
  assert.equal(verdict(new URL('https://a.com/x/1'), L, 'allow').blocked, 'url: https://a.com/x');
  assert.equal(verdict(new URL('https://b.a.com/'), L, 'allow').ask, 'domain: a.com', 'ask beats allow');
  assert.equal(verdict(new URL('https://c.com/'), L, 'ask').ask, 'default: ask');
  assert.equal(verdict(new URL('https://c.com/'), L, 'allow').allowedBy, 'default: allow');

  const ssh = await import('../src/plugins/ssh/rules.js');
  const S = [{ action: 'block' as const, kind: 'program' as const, value: 'rm', host: '' }, { action: 'ask' as const, kind: 'program' as const, value: 'systemctl', host: '' }, { action: 'allow' as const, kind: 'program' as const, value: 'ls', host: '' }];
  assert.equal(ssh.verdict('ls; systemctl restart x', 'h', S, 'allow').ask, 'program: systemctl');
  assert.equal(ssh.verdict('systemctl x; rm y', 'h', S, 'ask').blocked, 'program: rm');
  assert.equal(ssh.verdict('ls', 'h', S, 'ask').allowedBy, 'program: ls');
  assert.equal(ssh.verdict('ls; whoami', 'h', S, 'ask').ask, 'default: ask');
  assert.match(ssh.verdict('X=ls; $X', 'h', S, 'ask').ask!, /cannot check/, 'unanalyzable lines ask a human instead of failing');
  assert.ok(ssh.verdict('X=ls; $X', 'h', S, 'deny').blocked);
  // `\'` inside single quotes closes the quote: bash runs a chunk of python as a "program". Never offer it as a rule.
  const broken = JSON.parse(fs.readFileSync(new URL('./fixtures/ssh-broken-quotes.json', import.meta.url), 'utf8'));
  assert.ok(ssh.programs(broken).some((p) => p.includes('bounds=')), 'fixture still produces a junk program name');
  const d = ssh.describe(broken);
  assert.ok(d.programs.length > 0 && d.programs.every((p) => { try { ssh.normalize('program', p); return true; } catch { return false; } }), `offered: ${d.programs}`);
  assert.equal((await ssh.actions.rule.run({ action: 'ask', kind: 'program', value: 'curl' })).stored, true);
  assert.equal(ssh.rules().find((r) => r.value === 'curl')!.action, 'ask');
});

test('web plugin: ask verdict waits for approval, fails closed without an approval channel, logs approver', async () => {
  const site = http.createServer((_q, s) => { s.writeHead(200); s.end('ok'); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(site.address() as any).port}`;
  const web = (await import('../src/plugins/web/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');
  const act = (k: string, p: any = {}) => web.globalActions![k]!.run(p, {} as any);
  const inst = (await web.create({ instanceId: 'i', instanceName: 'web', serverId: 's', global: () => ({ stateIdleSec: 1, connectionIdleSec: 1, logRetentionDays: 30 }) as any, log: new ScopedLogger({}, () => 'off'),
    config: { ...web.defaultConfig, blockPrivateNetworks: false }, pluginConfig: { credentials: [] }, dep: () => { throw new Error(); } } as any)) as any;
  const tool = inst.tools.find((t: any) => t.name === 'request');
  await act('set_policy', { policy: 'ask' });

  let r = await tool.handler({ url: `${base}/a`, method: 'GET' }, { principal: 'tok', signal: new AbortController().signal });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /no approval channel/, 'no ask() = refused, never allowed');

  const asked: any[] = [];
  const yes = async (spec: any) => { asked.push(spec); return 'approved by jeff'; };
  r = await tool.handler({ url: `${base}/a?token=s3cret`, method: 'GET' }, { principal: 'tok', signal: new AbortController().signal, ask: yes });
  assert.equal(r.isError, false);
  assert.equal(asked[0].feature, 'url'); assert.equal(asked[0].reason, 'default: ask');
  assert.ok(!asked[0].summary.includes('s3cret'), 'summary hides the query'); assert.equal(asked[0].subject.url, `${base}/a?token=s3cret`);
  const log = await act('requests', {}) as any;
  assert.equal(log.rows[0].allowed_by, 'approved by jeff');

  const no = async () => { throw new Error('Awaiting human approval'); };
  r = await tool.handler({ url: `${base}/b`, method: 'GET' }, { principal: 'tok', signal: new AbortController().signal, ask: no });
  assert.match(r.content[0].text, /Awaiting human approval/);
  assert.match((await act('requests', {}) as any).rows[0].blocked, /awaiting approval: default: ask/);
  inst.stop(); site.close();
});

test('browserpaw: tool URLs ask; the extension gets ask rules as allow and default ask as allow', async () => {
  const policy = await import('../src/plugins/browserpaw/policy.js');
  const act = (k: string, p: any = {}) => (policy.actions as any)[k].run(p);
  await act('rule', { action: 'ask', kind: 'domain', value: 'ask.com' });
  await act('set_policy', { policy: 'deny' });
  let pushed: any;
  const call = async (_m: string, _p: string, body?: any) => { pushed = body; return { status: 'success', rev: body.rev, rejected: [] }; };
  await policy.push('p1', call as any);
  assert.equal(pushed.policy, 'deny'); assert.deepEqual(pushed.rules.map((r: any) => [r.action, r.value]), [['allow', 'ask.com']]);
  await act('set_policy', { policy: 'ask' });
  await policy.push('p1', call as any);
  assert.equal(pushed.policy, 'allow');

  const who = { principal: 'alice', sessionId: 's1' };
  await assert.rejects(policy.prepareCall('p1', 'chrome_navigate', { url: 'https://ask.com/' }, who), /no approval channel/);
  const asked: any[] = [];
  await policy.prepareCall('p1', 'chrome_navigate', { url: 'https://ask.com/' }, { ...who, ask: async (s: any) => { asked.push(s); return 'approved by jeff'; } });
  assert.deepEqual(asked[0].subject, { profile: 'p1', url: 'https://ask.com/', host: 'ask.com' });
});
