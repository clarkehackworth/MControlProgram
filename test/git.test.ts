import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-git-'));
process.env.MCONTROLPROGRAM_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = tmp; // the native git host's ~ (repos dir, ssh key)
await (await import('../src/core/plugin-loader.js')).loadPlugins(); // init: git gets mcp's rule store
const { default: plugin, globMatch, isMbox, agentBranch, slug, qp } = await import('../src/plugins/git/index.js');
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
let config: any = { hosts: [{ name: 'local', native: true, reposDir: '~/repos', token: 'SECRET123', provider: 'github' }], repos: [] };
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
  assert.equal(slug({ name: 'x', url: 'ssh://git@gitlab.example:2222/g/sub/r.git' }), 'g/sub/r');
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
  config.repos[0].url = 'https://github.com/o/demo'; // as if cloned from GitHub (git itself uses the clone's remote)
  const inst: any = await plugin.create({ instanceId: 'i', instanceName: 'git', serverId: 's', config: { repos: ['demo'] }, pluginConfig: config, global: () => ({}) as any, log, dep: () => undefined } as any);
  const asks: any[] = [];
  const call = { principal: 'agent1', client: 'test-client 1.0', signal: new AbortController().signal, log, ask: async (a: any) => { asks.push(a); return 'approved by test'; } };
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
  // re-signed by the host's identity, the agent named in the trailer (here: its MCP client)
  assert.equal(sh(origin, 'log', '-1', '--format=%s|%an|%cn', r1.sha), 'readme: greet the world|MControlProgram|MControlProgram');
  assert.match(sh(origin, 'log', '-1', '--format=%B', r1.sha), /\n\nAssisted-by: test-client 1\.0$/);
  assert.deepEqual(asks.map((a) => a.subject.features), [['submit_patch']]);

  // plain diff from main touching CI: not a fast-forward of agent/feat → refused without force, one combined ask with it
  sh(clone, 'reset', '-q', '--hard', main);
  fs.writeFileSync(path.join(clone, '.github/workflows/ci.yml'), 'on: [push, pull_request]\n');
  const diff = sh(clone, 'diff') + '\n';
  await assert.rejects(t('submit_patch').handler({ base: main, patch: diff, branch: 'agent/feat', message: 'ci: run on PRs' }, call), /force: true/);
  await assert.rejects(t('submit_patch').handler({ base: main, patch: diff, branch: 'feat2' }, call), /commit message/);
  await assert.rejects(t('submit_patch').handler({ base: 'main', patch: diff, branch: 'feat', message: 'm', force: true, assisted_by: 'x\nSigned-off-by: y' }, call), /invalid assisted_by/);
  const r2 = json(await t('submit_patch').handler({ base: 'main', patch: diff, branch: 'feat', message: 'ci: run on PRs', force: true, assisted_by: 'Claude Code (claude-opus-5-5)' }, call));
  assert.equal(r2.forced, true);
  assert.deepEqual(asks.at(-1).subject.features, ['submit_patch', 'force_push', 'sensitive_paths']);
  assert.match(sh(origin, 'log', '-1', '--format=%B', 'refs/heads/agent/feat'), /Submitted-by: agent1 via MControlProgram\nAssisted-by: Claude Code \(claude-opus-5-5\)/);

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
  // repos: the default branch counts as a base branch when none are configured
  assert.deepEqual(json(await inst.tools.find((x: any) => x.name === 'repos').handler({}, call))[0].baseBranches, ['main']);
  // delete_branch: agent branches only
  sh(clone, 'push', '-q', 'origin', `${main}:refs/heads/agent/old`);
  await assert.rejects(t('delete_branch').handler({ branch: 'main' }, call), /agent\/main.*does not exist/s, 'prefixed, so never main');
  assert.equal(sh(origin, 'rev-parse', 'main'), main);
  assert.deepEqual(json(await t('delete_branch').handler({ branch: 'old' }, call)), { deleted: 'agent/old' });
  assert.deepEqual(asks.at(-1).subject.features, ['delete_branch']);
  assert.throws(() => sh(origin, 'rev-parse', '--verify', '-q', 'refs/heads/agent/old'));
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
  assert.deepEqual(tools.filter((x: any) => x.upstream === 'demo' && x.read_only).map((x: any) => x.tool).sort(), ['clone_url', 'pr', 'resolve']);

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
    assert.match(seen[0], /^POST https:\/\/api\.github\.com\/repos\/o\/demo\/pulls Bearer SECRET123$/);
  } finally { globalThis.fetch = real; }
});

test('git remote over HTTP: clone, hidden local work, push forwarded with rules', async () => {
  const http = await import('node:http');
  const asks: any[] = [];
  let inst: any;
  const srv = http.createServer((req, res) => {
    const m = /^\/plugins\/git(\/.*)$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    req.url = m[1];
    void inst.http(req, res, { ask: async (_p: string, _t: string, spec: any) => { asks.push(spec); return 'approved by test'; } });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    inst = await plugin.create({ instanceId: 'i', instanceName: 'git', serverId: 's', config: { repos: ['demo'] }, pluginConfig: config, global: () => ({}) as any, log, dep: () => undefined, serverUrl: () => base } as any);
    const call = { principal: 'agent1', signal: new AbortController().signal, log, ask: async () => 'approved by test' };
    const cu = JSON.parse((await inst.tools.find((x: any) => x.name === 'clone_url').handler({}, call)).content[0].text);
    assert.equal(cu.url, `${base}/plugins/git/git/demo.git`);
    // async: the server runs in this process
    const { execFile } = await import('node:child_process');
    const run = (cwd: string, cmd: string) => new Promise<string>((ok, no) => execFile('sh', ['-c', cmd], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, // identity: what clone_url configured
      (e, stdout, stderr) => (e ? no(Object.assign(e, { stderr })) : ok(stdout))));
    const refused = async (cmd: Promise<string>, re: RegExp) => { try { await cmd; } catch (e: any) { assert.match(String(e.stderr), re); return; } assert.fail(`not refused: ${re}`); };

    // local work in the host clone is never served
    const host = path.join(tmp, 'repos/demo');
    sh(host, 'checkout', '-qb', 'secret'); fs.writeFileSync(path.join(host, 'secret.txt'), 'x'); sh(host, 'add', '-A'); sh(host, 'commit', '-qm', 'secret');
    const secret = sh(host, 'rev-parse', 'HEAD'); sh(host, 'checkout', '-q', 'main'); sh(host, 'tag', 'localtag-not-really', main);

    await run(tmp, cu.clone + ' agent2');
    const a2 = path.join(tmp, 'agent2');
    assert.equal(sh(a2, 'rev-parse', 'mcp/main'), sh(origin, 'rev-parse', 'main'));
    assert.equal(sh(a2, 'rev-parse', 'mcp/agent/feat'), sh(origin, 'rev-parse', 'agent/feat'));
    assert.ok(!(await run(a2, 'git ls-remote mcp')).includes('secret'));
    await refused(run(a2, `git fetch -q mcp ${secret}`), /not our ref|unadvertised/);
    await refused(run(a2, `git -c protocol.version=2 fetch -q mcp ${secret}`), /not our ref|unadvertised/);

    // push: forwarded to origin as is; only agent branches
    fs.writeFileSync(path.join(a2, 'new.txt'), 'n\n'); await run(a2, 'git add new.txt && git commit -qm "add new"');
    const mine = sh(a2, 'rev-parse', 'HEAD');
    await run(a2, 'git push -q mcp HEAD:agent/http');
    assert.equal(sh(origin, 'rev-parse', 'agent/http'), mine);
    assert.equal(sh(origin, 'log', '-1', '--format=%an|%cn', mine), 'MControlProgram|MControlProgram');
    assert.deepEqual(asks.at(-1).subject.features, ['git_push']);
    await run(a2, 'git fetch -q mcp');
    assert.equal(sh(a2, 'rev-parse', 'mcp/agent/http'), mine);
    await refused(run(a2, 'git push mcp HEAD:other'), /agent branch: git push mcp HEAD:agent\/other/);
    // the default branch: base_push, which a rule can deny
    await act('set_tool_rule', { upstream: 'demo', tool: 'base_push', action: 'deny' });
    await refused(run(a2, 'git push mcp HEAD:main'), /base_push|disabled/);
    assert.equal(sh(origin, 'rev-parse', 'main'), main);
    await act('set_tool_rule', { upstream: 'demo', tool: 'base_push', action: '' });
    await run(a2, 'git push -q mcp HEAD:main');
    assert.deepEqual(asks.at(-1).subject.features, ['git_push', 'base_push']);
    assert.equal(sh(origin, 'rev-parse', 'main'), mine);

    // rewrite: force needs force_push, and touching CI asks for sensitive_paths
    fs.writeFileSync(path.join(a2, '.github/workflows/ci.yml'), 'on: [push]\n'); await run(a2, 'git -c user.name=agent -c user.email=a@x commit -qa --amend --reset-author -m "ci too"');
    await run(a2, 'git push -qf mcp HEAD:agent/http');
    assert.deepEqual(asks.at(-1).subject.features, ['git_push', 'force_push', 'custom_identity', 'sensitive_paths']);
    assert.match(asks.at(-1).summary, /as agent <a@x>/);
    assert.equal(sh(origin, 'rev-parse', 'agent/http'), sh(a2, 'rev-parse', 'HEAD'));

    // a deny rule refuses, and the mirror goes back to origin's value
    await act('set_tool_rule', { upstream: 'demo', tool: 'git_push', action: 'deny' });
    await run(a2, 'git commit -q --allow-empty -m more');
    await refused(run(a2, 'git push mcp HEAD:agent/http'), /disabled by the administrator/);
    assert.equal(sh(path.join(tmp, 'repos/demo/.git/mcontrolprogram-serve.git'), 'rev-parse', 'agent/http'), sh(origin, 'rev-parse', 'agent/http'));
    await act('set_tool_rule', { upstream: 'demo', tool: 'git_push', action: '' });

    // bad token: a 403 that says what to do, no password prompt
    await refused(run(tmp, `git -c http.extraHeader="Authorization: Bearer nope" ls-remote ${cu.url}`), /expired MControlProgram git token/);
  } finally { srv.close(); }
});

test('PR providers: GitLab merge requests, Gitea, none', async () => {
  const { provider, apiBase } = await import('../src/plugins/git/providers.js');
  assert.equal(apiBase('github', {} as any, 'ghe.corp'), 'https://ghe.corp/api/v3');
  const real = globalThis.fetch; const seen: string[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  try {
    globalThis.fetch = (async (url: string, o: any) => {
      seen.push(`${o.method} ${url} ${o.headers['PRIVATE-TOKEN'] ?? o.headers.Authorization} ${o.body ?? ''}`);
      if (o.method === 'POST') return reply(409, { message: ['Another open merge request already exists for this source branch: !4'] });
      return reply(200, [{ iid: 4, title: 'Draft: t', state: 'opened', draft: true, source_branch: 'agent/x', target_branch: 'main', web_url: 'u', author: { username: 'bot' } }]);
    }) as any;
    const gl = provider({ name: 'h', provider: 'gitlab', token: 'T' }, { name: 'r', url: 'git@gitlab.example:grp/sub/r.git' });
    assert.deepEqual(await gl.create({ head: 'agent/x', base: 'main', title: 't', body: '', draft: true }),
      { number: 4, title: 'Draft: t', state: 'open', draft: true, head: 'agent/x', base: 'main', url: 'u', user: 'bot', updated: undefined, existing: true });
    assert.match(seen[0], /^POST https:\/\/gitlab\.example\/api\/v4\/projects\/grp%2Fsub%2Fr\/merge_requests T .*"source_branch":"agent\/x".*"title":"Draft: t"/);
    assert.match(seen[1], /merge_requests\?state=opened&source_branch=agent%2Fx/);

    seen.length = 0;
    globalThis.fetch = (async (url: string, o: any) => { seen.push(`${o.method} ${url} ${o.headers.Authorization}`); return reply(201, { number: 2, title: 'WIP: t', state: 'open', merged: false, head: { ref: 'agent/x' }, base: { ref: 'main' }, html_url: 'u' }); }) as any;
    const gt = provider({ name: 'h', provider: 'gitea', token: 'T', apiUrl: 'https://forge.example/api/v1/' }, { name: 'r', url: 'https://forge.example/o/r.git' });
    assert.equal((await gt.create({ head: 'agent/x', base: 'main', title: 't', body: '', draft: true })).draft, true);
    assert.equal(seen[0], 'POST https://forge.example/api/v1/repos/o/r/pulls token T');
  } finally { globalThis.fetch = real; }
  // merge / edit / review: the calls each forge gets
  try {
    const gh: string[] = [], gl: string[] = [], gt: string[] = [];
    const fake = (log: string[], res: (m: string, u: string) => unknown) => (async (url: string, o: any) => { log.push(`${o.method} ${new URL(url).pathname}${new URL(url).search} ${o.body ?? ''}`); return reply(200, res(o.method, url)); }) as any;
    const ghPr = { number: 3, title: 't', state: 'open', draft: false, head: { ref: 'agent/x', sha: 'abc' }, base: { ref: 'main' }, html_url: 'u', labels: [{ name: 'bug' }], assignees: [{ login: 'ann' }], requested_reviewers: [] };
    globalThis.fetch = fake(gh, (m, u) => (m === 'PUT' ? { merged: true, sha: 'm1' } : /\/pulls\/3$/.test(u) ? ghPr : /check-runs/.test(u) ? { check_runs: [] } : /status$/.test(u) ? { statuses: [] } : []));
    const p = provider({ name: 'h', provider: 'github', token: 'T' }, { name: 'r', url: 'git@github.com:o/r.git' });
    assert.deepEqual(await p.merge(3, { method: 'squash', sha: 'abc' }), { merged: true, sha: 'm1', message: undefined });
    assert.equal(gh[0], 'PUT /repos/o/r/pulls/3/merge {"merge_method":"squash","sha":"abc"}');
    gh.length = 0;
    const d = await p.edit(3, { state: 'closed', labels: { add: ['x'], remove: ['bug'] }, assignees: { add: ['bob'] }, reviewers: { add: ['cy'], remove: ['dee'] } });
    assert.deepEqual(d.labels, ['bug']);
    assert.deepEqual(gh.slice(0, 6), ['PATCH /repos/o/r/pulls/3 {"state":"closed"}', 'POST /repos/o/r/issues/3/labels {"labels":["x"]}', 'DELETE /repos/o/r/issues/3/labels/bug ',
      'POST /repos/o/r/issues/3/assignees {"assignees":["bob"]}', 'POST /repos/o/r/pulls/3/requested_reviewers {"reviewers":["cy"]}', 'DELETE /repos/o/r/pulls/3/requested_reviewers {"reviewers":["dee"]}']);
    await assert.rejects(p.edit(3, { draft: true }), /draft/);
    gh.length = 0; await p.review(3, { event: 'approve' });
    assert.equal(gh[0], 'POST /repos/o/r/pulls/3/reviews {"event":"APPROVE","body":""}');

    globalThis.fetch = fake(gt, (m, u) => (/\/labels\?/.test(u) ? [{ id: 7, name: 'bug' }] : m === 'GET' && /\/pulls\/3$/.test(u) ? { ...ghPr, title: 'WIP: t', merged: true, merge_commit_sha: 'm2' } : /\/pulls\/3\/merge/.test(u) ? null : /check-runs|status$/.test(u) ? {} : []));
    const g = provider({ name: 'h', provider: 'gitea', token: 'T', apiUrl: 'https://forge.example/api/v1' }, { name: 'r', url: 'https://forge.example/o/r.git' });
    assert.deepEqual(await g.merge(3, { method: 'rebase' }), { merged: true, sha: 'm2' });
    assert.equal(gt[0], 'POST /api/v1/repos/o/r/pulls/3/merge {"Do":"rebase"}');
    gt.length = 0;
    await g.edit(3, { draft: false, assignees: { remove: ['ann'], add: ['bob'] }, labels: { remove: ['bug'] } }).catch(() => {});
    assert.equal(gt[1], 'PATCH /api/v1/repos/o/r/pulls/3 {"title":"t","assignees":["bob"]}');
    assert.equal(gt[3], 'DELETE /api/v1/repos/o/r/issues/3/labels/7 ');
    gt.length = 0; await g.review(3, { event: 'approve' });
    assert.match(gt[0], /"event":"APPROVED"/);

    const mr = { iid: 4, title: 'Draft: t', state: 'opened', source_branch: 'agent/x', target_branch: 'main', assignees: [{ username: 'ann' }], reviewers: [], labels: ['bug'] };
    globalThis.fetch = fake(gl, (m, u) => (/merge$/.test(u) ? { state: 'merged', merge_commit_sha: 'm3' } : /members/.test(u) ? [{ id: 9, username: 'bob' }] : /\/merge_requests\/4$/.test(u) ? mr : /approvals$/.test(u) ? {} : m === 'POST' ? { id: 1 } : []));
    const l = provider({ name: 'h', provider: 'gitlab', token: 'T' }, { name: 'r', url: 'git@gitlab.example:g/r.git' });
    assert.deepEqual(await l.merge(4, { title: 'T', message: 'M' }), { merged: true, sha: 'm3' });
    assert.equal(gl[0], 'PUT /api/v4/projects/g%2Fr/merge_requests/4/merge {"squash":false,"merge_commit_message":"T\\n\\nM"}');
    await assert.rejects(l.merge(4, { method: 'rebase' }), /merge method/);
    gl.length = 0;
    await l.edit(4, { draft: false, state: 'open', labels: { add: ['a', 'b'] }, assignees: { add: ['bob'], remove: ['ann'] } });
    assert.equal(gl.find((x) => x.startsWith('PUT')), 'PUT /api/v4/projects/g%2Fr/merge_requests/4 {"title":"t","state_event":"reopen","add_labels":"a,b","assignee_ids":[9]}');
    gl.length = 0; await l.review(4, { event: 'approve', body: 'lgtm' });
    assert.deepEqual(gl.slice(0, 2).map((x) => x.split(' ').slice(0, 2).join(' ')), ['POST /api/v4/projects/g%2Fr/merge_requests/4/approve', 'POST /api/v4/projects/g%2Fr/merge_requests/4/notes']);
    await assert.rejects(l.review(4, { event: 'request_changes', body: 'x' }), /request-changes/);
  } finally { globalThis.fetch = real; }
  assert.throws(() => provider({ name: 'h', provider: 'none' }, { name: 'r', url: 'git@x:o/r' }), /no PR provider/);
  // a host without a provider: git tools only
  const inst: any = await plugin.create({ instanceId: 'i2', instanceName: 'git', serverId: 's', config: { repos: ['demo'] }, pluginConfig: { ...config, hosts: [{ ...config.hosts[0], provider: 'none' }] }, global: () => ({}) as any, log, dep: () => undefined } as any);
  assert.ok(!inst.tools.some((t: any) => ['create_pr', 'pr', 'comment'].includes(t.name)) && inst.tools.some((t: any) => t.name === 'clone_url'));
});

test('gh provider: PRs through the gh CLI on the git host, with its login', async () => {
  // a fake gh: logs its args and stdin, answers like `gh api`
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const log1 = path.join(tmp, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$*" >> ${log1}
case "$*" in
  "auth status") echo "  ✓ Logged in to github.com account bot (keyring)"; exit 0;;
  *"-X POST"*) cat >> ${log1}; echo '{"message":"Validation Failed","errors":[{"message":"A pull request already exists for o:agent/feat."}]}'; echo "gh: Validation Failed (HTTP 422)" >&2; exit 1;;
  *) echo '[{"number":9,"title":"t","state":"open","head":{"ref":"agent/feat"},"base":{"ref":"main"},"html_url":"u"}]';;
esac
`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const hosts = [{ ...config.hosts[0], provider: 'gh', token: undefined }];
    const s = await plugin.globalActions!.setup_host.run({ name: 'local' }, { config: { ...config, hosts }, setConfig: async () => {}, log, dep: () => undefined } as any) as any;
    assert.match(s.gh, /Logged in to github\.com/); assert.equal(s.ghNext, undefined);
    const inst: any = await plugin.create({ instanceId: 'i3', instanceName: 'git', serverId: 's', config: { repos: ['demo'] }, pluginConfig: { ...config, hosts, repos: config.repos.map((r: any) => ({ ...r, url: 'git@github.com:o/demo.git' })) }, global: () => ({}) as any, log, dep: () => undefined } as any);
    const call = { principal: 'agent1', signal: new AbortController().signal, log, ask: async () => 'approved by test' };
    const pr = JSON.parse((await inst.tools.find((x: any) => x.name === 'create_pr').handler({ branch: 'feat', title: 't', base: 'main' }, call)).content[0].text);
    assert.deepEqual([pr.number, pr.existing], [9, true]);
    const lines = fs.readFileSync(log1, 'utf8').split('\n');
    assert.ok(lines.includes("api -X POST -H X-GitHub-Api-Version: 2022-11-28 repos/o/demo/pulls --input -"), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('"head":"agent/feat"')), 'body on stdin');
  } finally { process.env.PATH = oldPath; }
});

test('a clone removed from the host drops out of the inventory', async () => {
  fs.rmSync(path.join(tmp, 'repos/demo'), { recursive: true });
  assert.deepEqual((await act('scan', { name: 'local' })).removed, ['demo']);
  assert.deepEqual(config.repos, []);
});
