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
const { default: plugin, globMatch, isMbox, agentBranch, slug, qp, workdirCheck } = await import('../src/plugins/git/index.js');
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
  // a base branch by its exact name: pushed there (base_push), fast-forward only
  fs.writeFileSync(path.join(clone, 'README.md'), 'to main\n');
  const toMain = sh(clone, 'diff', 'README.md') + '\n';
  const rm = json(await t('submit_patch').handler({ base: main, patch: toMain, branch: 'main', message: 'readme: to main' }, call));
  assert.equal(rm.branch, 'main');
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/main'), rm.sha);
  assert.deepEqual(asks.at(-1).subject.features, ['submit_patch', 'base_push']);
  await assert.rejects(t('submit_patch').handler({ base: main, patch: toMain, branch: 'main', message: 'again', force: true }, call), /never rewritten/);
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/main'), rm.sha);
  sh(origin, 'update-ref', 'refs/heads/main', main); // back, for the tests below
  // repos: the default branch counts as a base branch when none are configured
  assert.deepEqual(json(await inst.tools.find((x: any) => x.name === 'repos').handler({}, call))[0].baseBranches, ['main']);
  // delete_branch: agent branches only
  sh(clone, 'push', '-q', 'origin', `${main}:refs/heads/agent/old`);
  await assert.rejects(t('delete_branch').handler({ branch: 'main' }, call), /is a base branch/);
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
  assert.deepEqual(tools.filter((x: any) => x.upstream === 'demo' && x.read_only).map((x: any) => x.tool).sort(), ['clone_url', 'pr', 'resolve', 'stack', 'workdir_read']);

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

    // labels / assignees / reviewers go on a PR this call opens (through edit_pr's calls), and need edit_pr's approval too
    seen.length = 0;
    const open8 = { number: 8, title: 't8', state: 'open', draft: false, head: { ref: 'agent/feat', sha: 'abc' }, base: { ref: 'main' }, html_url: 'u8', labels: [{ name: 'bug' }], assignees: [], requested_reviewers: [] };
    globalThis.fetch = (async (url: string, o: any) => {
      const u = new URL(url); seen.push(`${o.method} ${u.pathname} ${o.body ?? ''}`);
      if (o.method === 'POST' && u.pathname.endsWith('/pulls')) return new Response(JSON.stringify(open8), { status: 201 });
      if (u.pathname.endsWith('/pulls/8')) return new Response(JSON.stringify(open8));
      if (u.pathname.endsWith('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }));
      if (u.pathname.endsWith('/status')) return new Response(JSON.stringify({ statuses: [] }));
      return new Response(JSON.stringify([]));
    }) as any;
    const pr8 = json(await t('create_pr').handler({ branch: 'feat', title: 't8', labels: ['bug'], reviewers: ['cy'] }, call));
    assert.equal(pr8.number, 8); assert.deepEqual(pr8.labels, ['bug']); assert.equal(pr8.warning, undefined);
    assert.ok(seen.includes('POST /repos/o/demo/issues/8/labels {"labels":["bug"]}'), seen.join('\n'));
    assert.ok(seen.includes('POST /repos/o/demo/pulls/8/requested_reviewers {"reviewers":["cy"]}'), seen.join('\n'));
    assert.deepEqual(asks.at(-1).subject.features, ['create_pr', 'edit_pr']);
    // without extras: no edit calls, and an existing PR is never modified
    seen.length = 0;
    await t('create_pr').handler({ branch: 'feat', title: 't' }, call);
    assert.equal(seen.length, 1, seen.join('\n'));

    // pr list: `search` keeps PRs whose title, branch or author has every word
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { number: 1, title: 'Fix login timeout', state: 'open', head: { ref: 'agent/a' }, base: { ref: 'main' }, html_url: 'u1', user: { login: 'ann' } },
      { number: 2, title: 'Add CSV export', state: 'open', head: { ref: 'agent/b' }, base: { ref: 'main' }, html_url: 'u2', user: { login: 'bob' } },
    ]))) as any;
    assert.deepEqual(json(await t('pr').handler({}, call)).map((x: any) => x.number), [1, 2]);
    assert.deepEqual(json(await t('pr').handler({ search: 'csv' }, call)).map((x: any) => x.number), [2]);
    assert.deepEqual(json(await t('pr').handler({ search: 'agent/a ann' }, call)).map((x: any) => x.number), [1]);
    assert.deepEqual(json(await t('pr').handler({ search: 'login bob' }, call)), []);

    // stacked PRs: stack_submit opens a chain (each on the branch below), then links them
    const nums: Record<string, number> = { 'agent/a': 21, 'agent/b': 22 };
    const stk = (extra: any = {}) => ({ number: 5, url: 'su', open: true, base: { ref: 'main' }, pull_requests: [21, 22].map((n) => ({ number: n, state: 'open', draft: true, merged_at: null, head: { ref: `agent/${n === 21 ? 'a' : 'b'}` } })), ...extra });
    let open: any[] = [], held = false;
    seen.length = 0;
    globalThis.fetch = (async (url: string, o: any) => {
      const u = new URL(url); seen.push(`${o.method} ${u.pathname}${u.search} ${o.body ?? ''}`);
      if (o.method === 'POST' && u.pathname.endsWith('/pulls')) { const b = JSON.parse(o.body); return new Response(JSON.stringify({ number: nums[b.head], title: b.title, state: 'open', draft: b.draft, head: { ref: b.head, sha: 's' }, base: { ref: b.base }, html_url: 'u' }), { status: 201 }); }
      if (u.pathname.endsWith('/pulls') && o.method === 'GET') return new Response(JSON.stringify(open));
      const one = u.pathname.match(/\/pulls\/(\d+)$/); if (one) return new Response(JSON.stringify({ ...open.find((x) => x.number === +one[1]), ...(o.method === 'PATCH' ? { base: { ref: JSON.parse(o.body).base } } : {}) }));
      if (/\/(check-runs|status)$/.test(u.pathname)) return new Response(JSON.stringify(u.pathname.endsWith('status') ? { statuses: [] } : { check_runs: [] }));
      if (u.pathname.endsWith('/stacks') && o.method === 'GET') return new Response(JSON.stringify(held ? [stk()] : []));
      if (u.pathname.endsWith('/stacks') && o.method === 'POST') { held = true; return new Response(JSON.stringify(stk()), { status: 201 }); }
      if (u.pathname.endsWith('/merge-async') && o.method === 'PUT') return new Response(JSON.stringify({ status: 'pending', details: { uuid: 'U1', merge_method: 'squash' } }), { status: 202 });
      if (u.pathname.endsWith('/merge-async/U1')) return new Response(JSON.stringify({ status: 'merged', details: { uuid: 'U1', sha: 'ms' } }));
      return new Response(JSON.stringify([]));
    }) as any;
    const sub = json(await t('stack_submit').handler({ layers: [{ branch: 'a', title: 'a' }, { branch: 'b', title: 'b' }] }, call));
    assert.deepEqual(sub.prs.map((x: any) => [x.branch, x.number, x.action]), [['agent/a', 21, 'create'], ['agent/b', 22, 'create']]);
    assert.equal(sub.created, true);
    const posts = seen.filter((x) => x.startsWith('POST') && x.includes('/pulls '));
    assert.match(posts[0], /"head":"agent\/a","base":"main".*"draft":true/);
    assert.match(posts[1], /"head":"agent\/b","base":"agent\/a"/);
    assert.ok(seen.includes('POST /repos/o/demo/stacks {"pull_requests":[21,22]}'), seen.join('\n'));
    assert.deepEqual(asks.at(-1).subject.features, ['stack_submit', 'create_pr']);
    // again: the PRs exist and are already stacked, so nothing changes (a wrong base is corrected, with edit_pr's approval)
    open = [21, 22].map((n, k) => ({ number: n, title: 't', state: 'open', draft: true, head: { ref: `agent/${k ? 'b' : 'a'}`, sha: 's' }, base: { ref: 'main' }, html_url: 'u' }));
    seen.length = 0;
    const again = json(await t('stack_submit').handler({ layers: [{ branch: 'a', title: 'x' }, { branch: 'b', title: 'x' }] }, call));
    assert.deepEqual(again.prs.map((x: any) => x.action), ['reuse', 'rebase']);
    assert.ok(seen.some((x) => x.startsWith('PATCH /repos/o/demo/pulls/22 {"base":"agent/a"}')), seen.join('\n'));
    assert.equal(again.unchanged, true);
    assert.deepEqual(asks.at(-1).subject.features, ['stack_submit', 'create_pr', 'edit_pr']);
    await assert.rejects(t('stack_submit').handler({ layers: [{ branch: 'a', title: 'x' }, { branch: 'a', title: 'x' }] }, call), /listed twice/);
    await assert.rejects(t('stack_submit').handler({ layers: [{ branch: 'a', title: 'x' }], base: 'feature/x' }, call), /base must be one of/);
    // stack read, link, merge (pending, then the result)
    assert.equal(json(await t('stack').handler({ pr: 21 }, call)).number, 5);
    assert.deepEqual(json(await t('stack').handler({ pr: 21 }, call)).prs.map((x: any) => x.number), [21, 22]);
    assert.equal(json(await t('stack_link').handler({ prs: [21, 22] }, call)).unchanged, true);
    const mg = json(await t('merge_stack').handler({ number: 22, method: 'squash' }, call));
    assert.deepEqual([mg.status, mg.sha], ['merged', 'ms']);
    assert.deepEqual(asks.at(-1).subject.features, ['merge_stack', 'merge_pr']);
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
    await refused(run(a2, 'git push -f mcp HEAD~1:main'), /never rewritten/);
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
    // GitHub's REST API can't change draft status: GraphQL does, by the PR's node id
    gh.length = 0;
    globalThis.fetch = fake(gh, (m, u) => (/graphql$/.test(u) ? { data: { convertPullRequestToDraft: {} } } : /\/pulls\/3$/.test(u) ? { ...ghPr, node_id: 'PR_x' } : /check-runs/.test(u) ? { check_runs: [] } : /status$/.test(u) ? { statuses: [] } : []));
    await p.edit(3, { draft: true });
    const gq = gh.find((x) => x.startsWith('POST /graphql'))!;
    assert.match(gq, /convertPullRequestToDraft.*"variables":\{"id":"PR_x"\}/);
    gh.length = 0; await p.edit(3, { draft: false });
    assert.ok(!gh.some((x) => x.includes('graphql')), 'already ready: nothing to do');
    globalThis.fetch = fake(gh, (m, u) => (/graphql$/.test(u) ? { errors: [{ message: 'Resource not accessible' }] } : /\/pulls\/3$/.test(u) ? { ...ghPr, node_id: 'PR_x' } : []));
    await assert.rejects(p.edit(3, { draft: true }), /Resource not accessible/);
    globalThis.fetch = fake(gh, (m, u) => (m === 'PUT' ? { merged: true, sha: 'm1' } : /\/pulls\/3$/.test(u) ? ghPr : /check-runs/.test(u) ? { check_runs: [] } : /status$/.test(u) ? { statuses: [] } : []));
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

test('GitHub stacks: REST /stacks through the provider; Gitea has none', async () => {
  const { provider } = await import('../src/plugins/git/providers.js');
  const real = globalThis.fetch; const log: string[] = [];
  const st = (n = 1) => ({ number: n, url: 'u', open: true, base: { ref: 'main' }, pull_requests: [{ number: 1, state: 'open', draft: false, merged_at: '2026-01-01', head: { ref: 'agent/a' } }, { number: 2, state: 'open', draft: true, merged_at: null, head: { ref: 'agent/b' } }] });
  let status = 200, body: any = st();
  globalThis.fetch = (async (url: string, o: any) => { const u = new URL(url); log.push(`${o.method} ${u.pathname}${u.search} ${o.body ?? ''}`); return new Response(status === 204 ? null : JSON.stringify(body), { status }); }) as any;
  try {
    const p = provider({ name: 'h', provider: 'github', token: 'T' }, { name: 'r', url: 'git@github.com:o/r.git' });
    const s = await p.stacks!.get(1);
    assert.deepEqual(s.prs.map((x) => [x.number, x.merged, x.head]), [[1, true, 'agent/a'], [2, false, 'agent/b']]);
    assert.equal(s.base, 'main');
    // list: newest first, closed ones dropped unless asked for, cut at the limit
    body = [st(3), { ...st(2), open: false }, st(1)];
    assert.deepEqual((await p.stacks!.list({ open: true, limit: 20 })).map((x) => x.number), [3, 1]);
    assert.deepEqual((await p.stacks!.list({ open: false, limit: 2 })).map((x) => x.number), [3, 2]);
    assert.equal(log.at(-1), 'GET /repos/o/r/stacks?per_page=100&page=1 ');
    body = [st()]; assert.equal((await p.stacks!.forPr(2))?.number, 1);
    assert.equal(log.at(-1), 'GET /repos/o/r/stacks?pull_request=2 ');
    body = []; assert.equal(await p.stacks!.forPr(9), null);
    body = st(); await p.stacks!.create([1, 2]); assert.equal(log.at(-1), 'POST /repos/o/r/stacks {"pull_requests":[1,2]}');
    await p.stacks!.add(1, [3]); assert.equal(log.at(-1), 'POST /repos/o/r/stacks/1/add {"pull_requests":[3]}');
    body = null; status = 204; assert.deepEqual(await p.stacks!.unstack(1), { dissolved: true });
    assert.equal(log.at(-1), 'POST /repos/o/r/stacks/1/unstack ');
    status = 200; body = { status: 'pending', details: { uuid: 'U', merge_method: 'squash', merge_action: 'default' } };
    assert.deepEqual(await p.stacks!.merge(2, { method: 'squash' }), { status: 'pending', uuid: 'U', method: 'squash', action: 'default', message: undefined, sha: undefined });
    assert.equal(log.at(-1), 'PUT /repos/o/r/pulls/2/merge-async {"merge_method":"squash","merge_action":"default"}');
    status = 404; body = { message: 'Not Found' };
    await assert.rejects(p.stacks!.get(1), /not enabled/);
    await assert.rejects(p.stacks!.merge(2, {}), /not available/);
    status = 409; await assert.rejects(p.stacks!.merge(2, {}), /already exists/);
    assert.equal(provider({ name: 'h', provider: 'gitea', token: 'T', apiUrl: 'https://g.example/api/v1' }, { name: 'r', url: 'https://g.example/o/r.git' }).stacks, undefined);
  } finally { globalThis.fetch = real; }
});

test('gh provider: draft status through gh api graphql', async () => {
  const { provider } = await import('../src/plugins/git/providers.js');
  const scripts: { script: string; input?: string }[] = [];
  const run = async (script: string, input?: string) => {
    scripts.push({ script, input });
    const out = / 'graphql'/.test(script) ? { data: {} } : /pulls\/5'/.test(script) ? { number: 5, title: 't', state: 'open', draft: true, node_id: 'N5', head: { ref: 'agent/x', sha: 's' }, base: { ref: 'main' }, html_url: 'u' } : /check-runs/.test(script) ? { check_runs: [] } : /status'/.test(script) ? { statuses: [] } : [];
    return { stdout: JSON.stringify(out), stderr: '', code: 0 };
  };
  const p = provider({ name: 'h', provider: 'gh' }, { name: 'r', url: 'git@github.com:o/r.git' }, undefined, run);
  await p.edit(5, { draft: false });
  const g = scripts.find((x) => / 'graphql'/.test(x.script))!;
  assert.match(g.script, /gh api -X POST -H 'X-GitHub-Api-Version: 2022-11-28' 'graphql' --input -$/);
  assert.match(g.input!, /markPullRequestReadyForReview.*"variables":\{"id":"N5"\}/);
});

test('working in the host clone: pull with a conflict, resolve, commit, push; risky git refused', async () => {
  for (const [c, args] of [['config', []], ['push', []], ['commit', ['-F', '/etc/passwd']], ['commit', ['-qF/x']], ['log', ['--out=x']], ['rebase', ['--exe=sh']], ['rebase', ['-ix', 'sh']], ['diff', ['--no-index', '/etc/passwd', 'x']], ['pull', ['/tmp/x']], ['fetch', ['https://evil/x']]] as [string, string[]][])
    assert.throws(() => workdirCheck(c, args), undefined, `${c} ${args}`);
  for (const [c, args] of [['pull', ['--rebase', 'origin', 'main']], ['commit', ['--message=Fix it']], ['log', ['--oneline', '-n', '3']], ['checkout', ['--', '-F']], ['stash', ['pop']]] as [string, string[]][])
    workdirCheck(c, args);

  const inst: any = await plugin.create({ instanceId: 'i4', instanceName: 'git', serverId: 's', config: { repos: ['demo'] }, pluginConfig: config, global: () => ({}) as any, log, dep: () => undefined } as any);
  const asks: any[] = [];
  const call = { principal: 'agent1', signal: new AbortController().signal, log, ask: async (a: any) => { asks.push(a); return 'approved by test'; } };
  const run = async (n: string, a: any) => (await inst.tools.find((x: any) => x.name === n).handler(a, call)).content[0].text as string;
  const git = (command: string, ...args: string[]) => run('git', { command, args });

  assert.match(await git('status'), /exit 0$/);
  assert.equal(asks.length, 0, 'read-only git runs under the read-only policy');
  assert.match(await git('fetch'), /exit 0$/);
  assert.match(await git('switch', '-c', 'work', 'origin/main'), /exit 0$/);
  // origin moves on while the clone edits the same line
  sh(clone, 'fetch', '-q', 'origin'); sh(clone, 'checkout', '-q', '-B', 'up', 'origin/main');
  fs.writeFileSync(path.join(clone, 'README.md'), 'theirs\n'); sh(clone, 'commit', '-qam', 'theirs'); sh(clone, 'push', '-q', 'origin', 'HEAD:main');
  await run('write_file', { path: 'README.md', content: 'ours\n' });
  assert.match(await git('commit', '--message=ours'), /exit 0$/);
  const pull = await git('pull', '--no-rebase', 'origin', 'main');
  assert.match(pull, /CONFLICT[\s\S]*exit 1$/);
  assert.match(await git('show', ':3:README.md'), /^theirs\n/);
  await run('write_file', { path: 'README.md', content: 'merged\n' });
  assert.match(await git('commit', '--no-edit'), /exit 0$/);
  const p = JSON.parse(await run('push', { branch: 'work' }));
  assert.equal(sh(origin, 'rev-parse', 'refs/heads/agent/work'), p.sha);
  assert.equal(sh(origin, 'show', `${p.sha}:README.md`), 'merged');
  assert.equal(sh(origin, 'log', '-1', '--format=%an', p.sha), 'MControlProgram');
  assert.ok(asks.some((a) => a.subject.features.includes('push')) && asks.some((a) => a.subject.features.includes('workdir')));
  assert.equal(JSON.parse(await run('push', { branch: 'work' })).unchanged, true);
  // the merge builds on main: it fast-forwards main, with base_push
  assert.equal(JSON.parse(await run('push', { branch: 'main' })).sha, sh(origin, 'rev-parse', 'main'));
  assert.ok(asks.at(-1).subject.features.includes('base_push'));
  assert.match(await git('reset', '--hard', 'HEAD~1'), /exit 0$/);
  await assert.rejects(run('push', { branch: 'main' }), /never rewritten/);

  // write_file stays inside the clone
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
  const wt = config.repos[0].path;
  fs.symlinkSync(outside, path.join(wt, 'lnk'));
  await run('write_file', { path: 'lnk/f', content: 'x' });
  assert.ok(!fs.existsSync(path.join(outside, 'f')) && fs.readFileSync(path.join(wt, 'lnk/f'), 'utf8') === 'x');
  await assert.rejects(run('write_file', { path: '.git/config', content: 'x' }));
  await assert.rejects(run('write_file', { path: '../x', content: 'x' }), /invalid path/);
});

test('a host-only repo (no origin) is its own origin', async () => {
  const solo = path.join(tmp, 'repos/solo');
  sh(tmp, 'init', '-q', '-b', 'main', solo);
  fs.writeFileSync(path.join(solo, 'a.txt'), 'a\n'); sh(solo, 'add', '-A'); sh(solo, 'commit', '-qm', 'a');
  const head = sh(solo, 'rev-parse', 'HEAD');
  assert.deepEqual((await act('scan', { name: 'local' })).added, ['solo']);
  const inst: any = await plugin.create({ instanceId: 'i5', instanceName: 'git', serverId: 's', config: { repos: ['solo'] }, pluginConfig: config, global: () => ({}) as any, log, dep: () => undefined } as any);
  const call = { principal: 'agent1', signal: new AbortController().signal, log, ask: async () => 'approved by test' };
  const run = async (n: string, a: any) => (await inst.tools.find((x: any) => x.name === n).handler(a, call)).content[0].text as string;
  assert.deepEqual(JSON.parse(await run('resolve', {})).branches, { main: head });
  assert.equal(JSON.parse(await run('resolve', {})).defaultBranch, 'main');
  assert.match(await run('git', { command: 'switch', args: ['-c', 'work'] }), /exit 0$/);
  await run('write_file', { path: 'a.txt', content: 'b\n' });
  assert.match(await run('git', { command: 'commit', args: ['--message=b'] }), /exit 0$/);
  const p = JSON.parse(await run('push', { branch: 'work' }));
  assert.equal(sh(solo, 'rev-parse', 'refs/heads/agent/work'), p.sha);
  // fast-forward the checked-out base branch: worktree follows (after switching back, main is checked out and clean)
  assert.match(await run('git', { command: 'switch', args: ['main'] }), /exit 0$/);
  // a half-done setup (origin there, config and default branch missing) gets repaired on the next call
  sh(solo, 'config', '--unset', 'receive.denyCurrentBranch'); sh(solo, 'remote', 'set-head', 'origin', '-d');
  assert.deepEqual(JSON.parse(await run('repos', {}))[0].baseBranches, ['main']);
  assert.equal(sh(solo, 'config', '--get', 'receive.denyCurrentBranch'), 'updateInstead');
  assert.equal(JSON.parse(await run('push', { branch: 'main', source: 'work' })).sha, sh(solo, 'rev-parse', 'main'));
  assert.equal(fs.readFileSync(path.join(solo, 'a.txt'), 'utf8'), 'b\n');
  fs.rmSync(solo, { recursive: true });
  assert.deepEqual((await act('scan', { name: 'local' })).removed, ['solo']);
});

test('a clone removed from the host drops out of the inventory', async () => {
  fs.rmSync(path.join(tmp, 'repos/demo'), { recursive: true });
  assert.deepEqual((await act('scan', { name: 'local' })).removed, ['demo']);
  assert.deepEqual(config.repos, []);
});
