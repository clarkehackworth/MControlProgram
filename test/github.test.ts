import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-github-'));
process.env.MCONTROLPROGRAM_DATA_DIR = path.join(tmp, 'data');
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // init: github gets mcp's rule store
const { default: plugin, globMatch, isMbox, agentBranch } = await import('../src/plugins/github/index.js');
const { ScopedLogger } = await import('../src/core/logger.js');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' } }).toString().trim();
const origin = path.join(tmp, 'origin.git'), clone = path.join(tmp, 'clone');
sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
sh(tmp, 'clone', '-q', origin, clone);
fs.mkdirSync(path.join(clone, '.github/workflows'), { recursive: true });
fs.writeFileSync(path.join(clone, 'README.md'), 'hello\n');
fs.writeFileSync(path.join(clone, '.github/workflows/ci.yml'), 'on: push\n');
sh(clone, 'add', '-A'); sh(clone, 'commit', '-qm', 'init'); sh(clone, 'push', '-q', 'origin', 'main');
const main = sh(clone, 'rev-parse', 'HEAD');

const repo = { name: 'demo', url: `file://${origin}`, token: 'SECRET123', committerName: 'bot', committerEmail: 'bot@x', branchPrefix: 'agent/', baseBranches: ['main'], askPaths: ['.github/', 'CODEOWNERS'], maxPatchKB: 64 };
const inst: any = await plugin.create({ instanceId: 'i', instanceName: 'github', serverId: 's', config: { repos: ['demo', 'down'] },
  pluginConfig: { repos: [repo, { ...repo, name: 'down', url: 'https://127.0.0.1:1/x.git' }] }, global: () => ({}) as any, log: new ScopedLogger({ category: 'test' }), dep: () => undefined } as any);
const asks: any[] = [];
const call = { principal: 'agent1', signal: new AbortController().signal, log: new ScopedLogger({ category: 'test' }), ask: async (a: any) => { asks.push(a); return 'approved by test'; } };
const t = (n: string) => inst.tools.find((x: any) => x.name === n);
const json = (r: any) => JSON.parse(r.content[0].text);

test('helpers', () => {
  assert.ok(globMatch('.github/', '.github/workflows/ci.yml') && globMatch('CODEOWNERS', 'CODEOWNERS') && !globMatch('.github/', '.githubx'));
  assert.ok(globMatch('**/*.yml', 'a/b/c.yml') && globMatch('**/*.yml', 'c.yml') && globMatch('src/*.ts', 'src/a.ts') && !globMatch('src/*.ts', 'src/a/b.ts'));
  assert.ok(isMbox(`From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\n`) && !isMbox('diff --git a/x b/x\n'));
  assert.equal(agentBranch(repo, 'feat'), 'agent/feat');
  assert.throws(() => agentBranch({ ...repo, branchPrefix: '' }, 'main'), /base branch/);
  for (const bad of ['../x', 'a..b', '-x', 'a b', 'x.lock', '']) assert.throws(() => agentBranch(repo, bad), undefined, bad);
});

test('resolve, submit (mbox, then plain diff with force + sensitive path), one ask per call, rules and log', async () => {
  assert.deepEqual(json(await t('resolve').handler({ repo: 'demo', ref: 'main' }, call)), { ref: 'main', sha: main });
  assert.equal(json(await t('resolve').handler({ repo: 'demo' }, call)).branches.main, main);
  assert.equal(asks.length, 0, 'read-only tools run under the default read-only policy');

  // agent commits locally and sends format-patch output: its message survives, MControlProgram commits as bot
  fs.writeFileSync(path.join(clone, 'README.md'), 'hello world\n');
  sh(clone, 'commit', '-qam', 'readme: greet the world');
  const mbox = sh(clone, 'format-patch', '--stdout', main) + '\n';
  const r1 = json(await t('submit_patch').handler({ repo: 'demo', base: main, patch: mbox, branch: 'feat' }, call));
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/agent/feat'), r1.sha);
  assert.equal(sh(origin, 'log', '-1', '--format=%s|%an|%cn', r1.sha), 'readme: greet the world|agent|bot');
  assert.deepEqual(asks.map((a) => a.subject.features), [['submit_patch']]);

  // plain diff from main touching CI: not a fast-forward of agent/feat → refused without force, one combined ask with it
  sh(clone, 'reset', '-q', '--hard', main);
  fs.writeFileSync(path.join(clone, '.github/workflows/ci.yml'), 'on: [push, pull_request]\n');
  const diff = sh(clone, 'diff') + '\n';
  await assert.rejects(t('submit_patch').handler({ repo: 'demo', base: main, patch: diff, branch: 'agent/feat', message: 'ci: run on PRs' }, call), /force: true/);
  await assert.rejects(t('submit_patch').handler({ repo: 'demo', base: main, patch: diff, branch: 'feat2' }, call), /commit message/);
  const r2 = json(await t('submit_patch').handler({ repo: 'demo', base: main, patch: diff, branch: 'feat', message: 'ci: run on PRs', force: true }, call));
  assert.equal(r2.forced, true);
  assert.deepEqual(asks.at(-1).subject.features, ['submit_patch', 'force_push', 'sensitive_paths']);
  assert.equal(asks.length, 2);
  assert.match(sh(origin, 'log', '-1', '--format=%B', 'refs/heads/agent/feat'), /Submitted-by: agent1 via MControlProgram/);
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/main'), main, 'base branch untouched');
  await assert.rejects(t('submit_patch').handler({ repo: 'demo', base: 'deadbeef', patch: diff, branch: 'x', message: 'm' }, call), /not on the remote/);
  await assert.rejects(t('submit_patch').handler({ repo: 'demo', base: main, patch: 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n', branch: 'x', message: 'm' }, call), /does not apply/);

  // an admin rule wins over the default; refusals land in the call log
  await plugin.globalActions!.set_tool_rule.run({ upstream: 'demo', tool: 'submit_patch', action: 'deny' }, {} as any);
  await assert.rejects(t('submit_patch').handler({ repo: 'demo', base: main, patch: mbox, branch: 'feat3' }, call), /disabled by the administrator/);
  const { rows } = await plugin.globalActions!.calls.run({ since: 0 }, {} as any) as any;
  assert.ok(rows.some((r: any) => r.tool === 'submit_patch' && r.blocked === 'tool rule: deny'));
  const { tools } = await plugin.globalActions!.tool_rules.run({}, { config: { repos: [repo] } } as any) as any;
  assert.deepEqual(tools.filter((x: any) => x.upstream === 'demo' && x.read_only).map((x: any) => x.tool).sort(), ['pr', 'resolve']);
});

test('the token never reaches the agent', async () => {
  const e = await t('resolve').handler({ repo: 'down', ref: 'main' }, call).then(() => null, (e: Error) => e);
  assert.ok(e && !e.message.includes('SECRET123') && !e.message.includes(Buffer.from('x-access-token:SECRET123').toString('base64')), e?.message);
});

test('create_pr returns the open PR when one exists', async () => {
  const real = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = (async (url: string, o: any) => {
    seen.push(`${o.method} ${url} ${o.headers.Authorization}`);
    if (o.method === 'POST') return new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:agent/feat.' }] }), { status: 422 });
    return new Response(JSON.stringify([{ number: 7, title: 't', state: 'open', head: { ref: 'agent/feat' }, base: { ref: 'main' }, html_url: 'u' }]));
  }) as any;
  try {
    const pr = json(await t('create_pr').handler({ repo: 'demo', branch: 'feat', title: 't' }, call));
    assert.equal(pr.number, 7); assert.equal(pr.existing, true);
    assert.match(seen[0], /^POST https:\/\/api\.github\.com\/repos\/[^/]+\/origin\/pulls Bearer SECRET123$/);
  } finally { globalThis.fetch = real; }
});
