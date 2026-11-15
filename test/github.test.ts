import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-github-'));
process.env.MCONTROLPROGRAM_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = tmp; // the native git host's ~ (repos dir, ssh key)
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // init: github gets mcp's rule store
const { default: plugin, globMatch, isMbox, agentBranch, slug, qp } = await import('../src/plugins/github/index.js');
const { ScopedLogger } = await import('../src/core/logger.js');
const log = new ScopedLogger({ category: 'test' });

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' } }).toString().trim();
const origin = path.join(tmp, 'demo.git'), clone = path.join(tmp, 'agent');
sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
sh(tmp, 'clone', '-q', origin, clone);
fs.mkdirSync(path.join(clone, '.github/workflows'), { recursive: true });
fs.writeFileSync(path.join(clone, 'README.md'), 'hello\n');
fs.writeFileSync(path.join(clone, '.github/workflows/ci.yml'), 'on: push\n');
sh(clone, 'add', '-A'); sh(clone, 'commit', '-qm', 'init'); sh(clone, 'push', '-q', 'origin', 'main');
const main = sh(clone, 'rev-parse', 'HEAD');

// admin side: a native git host; actions save config here
let config: any = { hosts: [{ name: 'local', native: true, reposDir: '~/repos', token: 'SECRET123' }], repos: [] };
const act = (k: string, p: any) => plugin.globalActions![k].run(p, { config, setConfig: async (c: any) => { config = c; }, log, dep: () => undefined } as any) as Promise<any>;

test('helpers', () => {
  assert.ok(globMatch('.github/', '.github/workflows/ci.yml') && globMatch('CODEOWNERS', 'CODEOWNERS') && !globMatch('.github/', '.githubx'));
  assert.ok(globMatch('**/*.yml', 'a/b/c.yml') && globMatch('**/*.yml', 'c.yml') && globMatch('src/*.ts', 'src/a.ts') && !globMatch('src/*.ts', 'src/a/b.ts'));
  assert.ok(isMbox(`From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\n`) && !isMbox('diff --git a/x b/x\n'));
  const r = { branchPrefix: 'agent/', baseBranches: ['main'] };
  assert.equal(agentBranch(r, 'feat'), 'agent/feat');
  assert.throws(() => agentBranch({ ...r, branchPrefix: '' }, 'main'), /base branch/);
  for (const bad of ['../x', 'a..b', 'a b', 'x.lock', '', "a'b"]) assert.throws(() => agentBranch(r, bad), undefined, bad);
  assert.equal(slug({ name: 'x', url: 'git@github.com:o/r.git' }), 'o/r');
  assert.equal(slug({ name: 'x', url: 'https://github.com/o/r' }), 'o/r');
  assert.equal(execFileSync('sh', ['-c', `printf %s ${qp("~/a b'c")}`], { env: { ...process.env, HOME: '/h' } }).toString(), "/h/a b'c");
});

test('host setup makes a key; clone and scan fill the repos inventory', async () => {
  const s = await act('setup_host', { name: 'local' });
  assert.match(s.publicKey, /^ssh-ed25519 /);
  assert.ok(fs.existsSync(path.join(tmp, '.ssh/mcontrolprogram_git')));
  assert.deepEqual(s.repos, []);
  const c = await act('clone', { host: 'local', url: `file://${origin}` });
  assert.deepEqual([c.dir, c.added], ['demo', ['demo']]);
  assert.deepEqual(config.repos.map((r: any) => [r.name, r.host, r.path, r.url, r.branchPrefix]), [['demo', 'local', fs.realpathSync(path.join(tmp, 'repos/demo')), `file://${origin}`, 'agent/']]);
  await assert.rejects(act('clone', { host: 'local', url: `file://${origin}` }), /already exists/);
  await assert.rejects(act('clone', { host: 'local', url: `--upload-pack=x` }), /clone URL/);
  config.repos[0].baseBranches = ['main']; // admin edits survive rescans
  const before = config;
  assert.deepEqual((await act('scan', { name: 'local' })).added, []);
  assert.equal(config, before, 'no change, no save (saving restarts instances)');
});

test('resolve, submit (mbox, then plain diff with force + sensitive path), one ask per call, rules and log', async () => {
  const inst: any = await plugin.create({ instanceId: 'i', instanceName: 'github', serverId: 's', config: { repos: ['demo'] }, pluginConfig: config, global: () => ({}) as any, log, dep: () => undefined } as any);
  const asks: any[] = [];
  const call = { principal: 'agent1', signal: new AbortController().signal, log, ask: async (a: any) => { asks.push(a); return 'approved by test'; } };
  const t = (n: string) => inst.tools.find((x: any) => x.name === n);
  const json = (r: any) => JSON.parse(r.content[0].text);

  assert.deepEqual(json(await t('resolve').handler({ ref: 'main' }, call)), { ref: 'main', sha: main });
  const list = json(await t('resolve').handler({}, call));
  assert.deepEqual([list.defaultBranch, list.branches], ['main', { main }]);
  assert.equal(asks.length, 0, 'read-only tools run under the default read-only policy');

  // agent commits locally and sends format-patch output: its message survives, MControlProgram commits as the bot
  fs.writeFileSync(path.join(clone, 'README.md'), 'hello world\n');
  sh(clone, 'commit', '-qam', 'readme: greet the world');
  const mbox = sh(clone, 'format-patch', '--stdout', main) + '\n';
  const r1 = json(await t('submit_patch').handler({ base: main, patch: mbox, branch: 'feat' }, call));
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/agent/feat'), r1.sha);
  assert.equal(sh(origin, 'log', '-1', '--format=%s|%an|%cn', r1.sha), 'readme: greet the world|agent|MControlProgram');
  assert.deepEqual(asks.map((a) => a.subject.features), [['submit_patch']]);

  // plain diff from main touching CI: not a fast-forward of agent/feat → refused without force, one combined ask with it
  sh(clone, 'reset', '-q', '--hard', main);
  fs.writeFileSync(path.join(clone, '.github/workflows/ci.yml'), 'on: [push, pull_request]\n');
  const diff = sh(clone, 'diff') + '\n';
  await assert.rejects(t('submit_patch').handler({ base: main, patch: diff, branch: 'agent/feat', message: 'ci: run on PRs' }, call), /force: true/);
  await assert.rejects(t('submit_patch').handler({ base: main, patch: diff, branch: 'feat2' }, call), /commit message/);
  const r2 = json(await t('submit_patch').handler({ base: 'main', patch: diff, branch: 'feat', message: 'ci: run on PRs', force: true }, call));
  assert.equal(r2.forced, true);
  assert.deepEqual(asks.at(-1).subject.features, ['submit_patch', 'force_push', 'sensitive_paths']);
  assert.match(sh(origin, 'log', '-1', '--format=%B', 'refs/heads/agent/feat'), /Submitted-by: agent1 via MControlProgram/);

  // committer identity from the agent: committer (and author of a plain diff), its own rule feature
  fs.writeFileSync(path.join(clone, 'README.md'), 'hi\n');
  const readme = sh(clone, 'diff', 'README.md') + '\n';
  await assert.rejects(t('submit_patch').handler({ base: r2.sha, patch: readme, branch: 'feat', message: 'm', committer_name: 'Ada' }, call), /go together/);
  await assert.rejects(t('submit_patch').handler({ base: r2.sha, patch: readme, branch: 'feat', message: 'm', committer_name: 'Ada', committer_email: 'x>@y\nz' }, call), /invalid committer_email/);
  const r3 = json(await t('submit_patch').handler({ base: r2.sha, patch: readme, branch: 'feat', message: 'readme: hi', committer_name: 'Ada Lovelace', committer_email: 'ada@example.com' }, call));
  assert.equal(sh(origin, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', r3.sha), 'Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>');
  assert.deepEqual(asks.at(-1).subject.features, ['submit_patch', 'custom_identity']);
  assert.match(asks.at(-1).summary, /as Ada Lovelace <ada@example\.com>/);

  assert.equal(sh(origin, 'rev-parse', 'refs/heads/main'), main, 'base branch untouched');
  await assert.rejects(t('submit_patch').handler({ base: 'deadbeef', patch: diff, branch: 'x', message: 'm' }, call), /not on the remote/);
  await assert.rejects(t('submit_patch').handler({ base: main, patch: 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n', branch: 'x', message: 'm' }, call), /does not apply/);
  assert.equal(fs.readdirSync(path.join(tmp, 'repos/demo/.git/mcontrolprogram-work')).length, 0, 'worktrees cleaned up');
  assert.equal(sh(path.join(tmp, 'repos/demo'), 'status', '--porcelain'), '', "the host clone's own checkout is untouched");

  // an admin rule wins over the default; refusals land in the call log
  await act('set_tool_rule', { upstream: 'demo', tool: 'submit_patch', action: 'deny' });
  await assert.rejects(t('submit_patch').handler({ base: main, patch: mbox, branch: 'feat3' }, call), /disabled by the administrator/);
  const { rows } = await act('calls', { since: 0 });
  assert.ok(rows.some((r: any) => r.tool === 'submit_patch' && r.blocked === 'tool rule: deny'));
  const { tools } = await act('tool_rules', {});
  assert.deepEqual(tools.filter((x: any) => x.upstream === 'demo' && x.read_only).map((x: any) => x.tool).sort(), ['pr', 'resolve']);

  // PRs go to the API with the host's token; an existing PR for the branch is returned
  const real = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = (async (url: string, o: any) => {
    seen.push(`${o.method} ${url} ${o.headers.Authorization}`);
    if (o.method === 'POST') return new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:agent/feat.' }] }), { status: 422 });
    return new Response(JSON.stringify([{ number: 7, title: 't', state: 'open', head: { ref: 'agent/feat' }, base: { ref: 'main' }, html_url: 'u' }]));
  }) as any;
  try {
    const pr = json(await t('create_pr').handler({ branch: 'feat', title: 't' }, call));
    assert.deepEqual([pr.number, pr.existing], [7, true]);
    assert.match(seen[0], /^POST https:\/\/api\.github\.com\/repos\/[^/]+\/demo\/pulls Bearer SECRET123$/);
  } finally { globalThis.fetch = real; }
});

test('a clone removed from the host drops out of the inventory', async () => {
  fs.rmSync(path.join(tmp, 'repos/demo'), { recursive: true });
  assert.deepEqual((await act('scan', { name: 'local' })).removed, ['demo']);
  assert.deepEqual(config.repos, []);
});
