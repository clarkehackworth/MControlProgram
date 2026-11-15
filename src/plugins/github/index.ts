/**
 * GitHub through MControlProgram: agents keep a read-only clone, MControlProgram keeps a mirror and the write token.
 * An agent pins its clone with `resolve`, sends a patch with the commit it was based on (`submit_patch`), and
 * MControlProgram applies, commits and pushes it to an agent branch, opens PRs and reads their state.
 *
 * Every tool and git feature (force push, touching CI paths) is allow / ask / deny per repo, using mcp's rule store
 * (own `github_*` tables, same panel as the MCP pass-through). One call asks once, for everything it touches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MControlProgramPlugin, PluginContext, PluginHost, PluginInstance, ToolCallContext, ToolDefinition } from '../../core/plugin-api.js';
import { text } from '../../core/plugin-api.js';
import type { McpApi } from '../mcp/index.js';
import type { ToolRuleStore, LogEntry } from '../mcp/rules.js';

export interface RepoCfg {
  name: string; url: string; token?: string; apiUrl?: string; description?: string;
  committerName: string; committerEmail: string; branchPrefix: string; baseBranches: string[]; askPaths: string[]; maxPatchKB: number;
}
interface GlobalCfg { repos: RepoCfg[] }
interface Cfg { repos: string[]; reposDisabled?: string[] }

/** Tools and git features the rules apply to, per repo. `ro` = read-only (allowed under the read-only policy). */
export const FEATURES: { name: string; ro: boolean; description: string }[] = [
  { name: 'resolve', ro: true, description: 'Fetch, then resolve a branch, tag or sha to a commit, or list branches and tags' },
  { name: 'submit_patch', ro: false, description: 'Apply a patch on a base commit, commit it and push it to an agent branch' },
  { name: 'force_push', ro: false, description: 'submit_patch that rewrites an agent branch (not a fast-forward)' },
  { name: 'sensitive_paths', ro: false, description: "submit_patch touching the repo's ask paths (CI workflows, CODEOWNERS…)" },
  { name: 'create_pr', ro: false, description: 'Open a pull request from an agent branch' },
  { name: 'pr', ro: true, description: 'List pull requests, or read one: state, checks, reviews and comments' },
  { name: 'comment', ro: false, description: 'Comment on a pull request or issue' },
];
const RO = Object.fromEntries(FEATURES.map((f) => [f.name, f.ro]));

let host: PluginHost;
let rules: ToolRuleStore;

// ---- git ----------------------------------------------------------------------------------------------------

/** The token reaches git through env-only config (never argv, never .git/config), scoped to the repo's origin. */
function gitEnv(r: RepoCfg): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_NAME: r.committerName, GIT_COMMITTER_EMAIL: r.committerEmail, GIT_AUTHOR_NAME: r.committerName, GIT_AUTHOR_EMAIL: r.committerEmail };
  if (r.token && /^https?:/.test(r.url)) {
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${new URL(r.url).origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${r.token}`).toString('base64')}` });
  }
  return env;
}
const scrub = (r: RepoCfg, s: string) => (r.token ? s.split(r.token).join('***').split(Buffer.from(`x-access-token:${r.token}`).toString('base64')).join('***') : s);

/** Run git with repo hooks off and no credential helpers. Rejects with git's stderr (token scrubbed). */
export function git(r: RepoCfg, args: string[], o: { cwd?: string; input?: string; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', ...args],
      { cwd: o.cwd, env: gitEnv(r), maxBuffer: 64 << 20, timeout: 300_000, signal: o.signal },
      (e, stdout, stderr) => (e ? reject(new Error(scrub(r, `git ${args.find((a) => !a.startsWith('-'))}: ${(stderr || e.message).trim()}`))) : resolve(stdout)));
    if (o.input !== undefined) p.stdin!.end(o.input);
  });
}

const mirror = (r: RepoCfg) => path.join(host.dataDir, r.name.replace(/[^A-Za-z0-9._-]/g, '_') + '.git');
// ponytail: one fetch at a time per repo (git locks refs); worktrees and pushes don't touch the mirror's refs
const fetching = new Map<string, Promise<void>>();
/** Bring the mirror up to date with the remote (all branches and tags), creating it on first use. */
export function sync(r: RepoCfg, signal?: AbortSignal): Promise<void> {
  const dir = mirror(r);
  const prev = fetching.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (!fs.existsSync(path.join(dir, 'HEAD'))) { fs.mkdirSync(dir, { recursive: true }); await git(r, ['init', '-q', '--bare', dir]); }
    await git(r, ['--git-dir', dir, 'fetch', '-q', '--prune', '--no-tags', r.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], { signal });
  });
  fetching.set(dir, next);
  return next.finally(() => { if (fetching.get(dir) === next) fetching.delete(dir); });
}

const REF = /^[^-\s][^\s]*$/;
async function commitOf(r: RepoCfg, ref: string): Promise<string | undefined> {
  if (!REF.test(ref)) throw new Error(`invalid ref "${ref}"`);
  return git(r, ['--git-dir', mirror(r), 'rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`]).then((s) => s.trim(), () => undefined);
}

async function defaultBranch(r: RepoCfg): Promise<string | undefined> {
  const out = await git(r, ['ls-remote', '--symref', r.url, 'HEAD']).catch(() => '');
  return /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out)?.[1];
}

/** The agent branch for `branch`: the repo's prefix added when missing; never a base branch. */
export function agentBranch(r: RepoCfg, branch: string): string {
  const b = branch.startsWith(r.branchPrefix) ? branch : r.branchPrefix + branch;
  if (!b || b === r.branchPrefix || !/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..') || b.includes('//') || /(^|\/)[.-]|\.lock$|\/$/.test(b))
    throw new Error(`invalid branch name "${branch}"`);
  if (r.baseBranches.includes(b)) throw new Error(`"${b}" is a base branch; push to an agent branch and open a PR`);
  return b;
}

/** `**` = any path, `*` = within one component; a pattern without wildcards also matches everything under it. */
export function globMatch(pattern: string, file: string): boolean {
  const p = pattern.replace(/^\/+/, '');
  if (!/[*?]/.test(p)) return file === p || file.startsWith(p.replace(/\/$/, '') + '/');
  const re = p.split(/(\*\*\/?|\*|\?)/).map((t) => (t === '**' || t === '**/' ? '(?:.*/)?' + (t === '**' ? '.*' : '') : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${re}$`).test(file);
}

/** A mailbox (`git format-patch`) keeps the agent's commits and messages; anything else is a plain diff. */
export const isMbox = (patch: string) => /^(From [0-9a-f]{40} |From: |Subject: )/.test(patch.trimStart());

interface Applied { sha: string; base: string; commits: number; files: string[]; force: boolean; previous?: string }
/**
 * Apply `patch` on `base` in a throwaway worktree and commit it (nothing is pushed). Returns what it made,
 * and whether pushing to `branch` would rewrite it.
 */
async function apply(r: RepoCfg, a: { base: string; patch: string; branch: string; message?: string; principal?: string }, signal?: AbortSignal): Promise<Applied & { push(): Promise<void>; done(): Promise<void> }> {
  const dir = mirror(r);
  const base = await commitOf(r, a.base);
  if (!base) throw new Error(`base "${a.base}" is not on the remote. Base the patch on a pushed commit (see resolve) and include every commit since then.`);
  const previous = await git(r, ['--git-dir', dir, 'rev-parse', '-q', '--verify', `refs/heads/${a.branch}`]).then((s) => s.trim(), () => undefined);
  const wt = path.join(host.dataDir, 'work', randomUUID());
  await git(r, ['--git-dir', dir, 'worktree', 'add', '-q', '--detach', wt, base]);
  const done = async () => { await git(r, ['--git-dir', dir, 'worktree', 'remove', '--force', wt]).catch(() => { fs.rmSync(wt, { recursive: true, force: true }); return git(r, ['--git-dir', dir, 'worktree', 'prune']); }).catch(() => {}); };
  try {
    if (isMbox(a.patch)) {
      await git(r, ['am', '-q', '--3way', '--no-gpg-sign'], { cwd: wt, input: a.patch, signal }).catch(async (e) => { await git(r, ['am', '--abort'], { cwd: wt }).catch(() => {}); throw conflict(e); });
    } else {
      if (!a.message?.trim()) throw new Error('a plain diff needs a commit message (or send `git format-patch` output)');
      await git(r, ['apply', '--index', '--3way', '--whitespace=nowarn'], { cwd: wt, input: a.patch, signal }).catch((e) => { throw conflict(e); });
      await git(r, ['commit', '-q', '--no-gpg-sign', '-m', a.message, ...(a.principal ? ['--trailer', `Submitted-by: ${a.principal} via MControlProgram`] : [])], { cwd: wt });
    }
    const sha = (await git(r, ['rev-parse', 'HEAD'], { cwd: wt })).trim();
    if (sha === base) throw new Error('the patch changes nothing');
    const commits = Number((await git(r, ['rev-list', '--count', `${base}..${sha}`], { cwd: wt })).trim());
    const files = (await git(r, ['diff', '--name-only', '-z', base, sha], { cwd: wt })).split('\0').filter(Boolean);
    const force = !!previous && previous !== sha && !(await git(r, ['merge-base', '--is-ancestor', previous, sha], { cwd: wt }).then(() => true, () => false));
    // the lease makes the push fail if the branch moved since we looked, instead of overwriting someone's work
    const push = () => git(r, ['push', '-q', '--no-verify', `--force-with-lease=refs/heads/${a.branch}:${previous ?? ''}`, r.url, `${sha}:refs/heads/${a.branch}`], { cwd: wt, signal }).then(() => {});
    return { sha, base, commits, files, force, previous, push, done };
  } catch (e) { await done(); throw e; }
}
const conflict = (e: Error) => new Error(`the patch does not apply: ${e.message}\nresolve the base branch's current commit, rebase onto it and submit again`);

// ---- GitHub REST --------------------------------------------------------------------------------------------

/** owner/repo from the clone URL's last two path segments. */
export const slug = (r: RepoCfg) => {
  const m = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.url);
  if (!m) throw new Error(`cannot tell owner/repo from ${r.url}`);
  return `${m[1]}/${m[2]}`;
};
async function gh(r: RepoCfg, method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  if (!r.token) throw new Error(`repo "${r.name}" has no token`);
  const res = await fetch(`${(r.apiUrl || 'https://api.github.com').replace(/\/$/, '')}/repos/${slug(r)}${p}`, {
    method, signal, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${r.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MControlProgram', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(scrub(r, `GitHub ${method} ${p}: ${res.status} ${j?.message ?? res.statusText}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`)), { status: res.status, body: j });
  return j;
}
const prSummary = (p: any) => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: p.draft, head: p.head?.ref, base: p.base?.ref, url: p.html_url, user: p.user?.login, updated: p.updated_at });

// ---- plugin -------------------------------------------------------------------------------------------------

const repoSchema = {
  type: 'object',
  required: ['name', 'url', 'committerName', 'committerEmail'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'What agents call the repo' },
    url: { type: 'string', title: 'Clone URL (https)', description: 'e.g. https://github.com/owner/repo.git' },
    token: { type: 'string', title: 'Token', 'x-secret': true, description: 'Fine-grained PAT for this repo: Contents and Pull requests read & write. Never shown to agents.' },
    apiUrl: { type: 'string', title: 'API URL', description: 'Empty = https://api.github.com (GitHub Enterprise: https://host/api/v3)', 'x-no-column': true },
    description: { type: 'string', title: 'Description', 'x-no-column': true },
    committerName: { type: 'string', title: 'Committer name', default: 'MControlProgram', 'x-no-column': true },
    committerEmail: { type: 'string', title: 'Committer email', default: 'mcontrolprogram@users.noreply.github.com', 'x-no-column': true },
    branchPrefix: { type: 'string', title: 'Agent branch prefix', description: 'Agents push only to branches starting with this', default: 'agent/' },
    baseBranches: { type: 'array', title: 'Base branches', description: 'PR targets; never pushed to. Empty = the default branch.', items: { type: 'string' }, default: [] },
    askPaths: { type: 'array', title: 'Sensitive paths', description: 'Patches touching these use the sensitive_paths rule (** any path, * one component; a plain path covers everything under it)', items: { type: 'string' }, default: ['.github/', 'CODEOWNERS'], 'x-no-column': true },
    maxPatchKB: { type: 'integer', title: 'Max patch size (KB)', default: 2048, 'x-no-column': true },
  },
};

const plugin: MControlProgramPlugin = {
  id: 'github',
  name: 'GitHub',
  version: '0.1.0',
  navOrder: 35,
  dependencies: { mcp: '^0.2.0' },
  description: 'Agents with a read-only clone sync to the same commit and submit patches; MControlProgram holds the token, commits, pushes to agent branches and opens PRs. Every tool and git feature is allow / ask / deny per repo.',
  init(h) { host = h; rules = h.dep<McpApi>('mcp').toolRuleStore(() => h.db, 'github', { defaultPolicy: 'readonly' }); },
  globalConfigSchema: { type: 'object', properties: { repos: { type: 'array', title: 'Repositories', items: repoSchema, default: [] } } },
  defaultGlobalConfig: { repos: [] },
  onRenamed: (key, from, to) => { if (key === 'repos') rules.renameUpstream(from, to); },
  globalActions: {
    // the shared rules panel's actions; `rules` exists once init ran
    ...Object.fromEntries((['set_tool_rule', 'set_policy', 'calls', 'clear_calls'] as const).map((k) => [k, { hidden: true, title: k, run: (p: any) => rules.actions[k].run(p) }])),
    // the feature list is fixed: list it for every repo, so the panel shows repos no server exposes yet
    tool_rules: { hidden: true, title: 'Tool rules', run: async (_p, a) => { for (const r of (a.config as GlobalCfg).repos) rules.seen(r.name, featureList); return rules.actions.tool_rules.run(); } },
    check_repo: {
      title: 'Check repo', inventory: 'repos',
      async run({ name }, a) {
        const found = (a.config as GlobalCfg).repos.find((x) => x.name === name);
        if (!found) throw new Error('unknown repo');
        const r = withDefaults(found);
        await sync(r);
        const out: Record<string, unknown> = { fetched: true, defaultBranch: await defaultBranch(r) };
        if (r.token) { const j = await gh(r, 'GET', ''); out.repo = j.full_name; out.canPush = !!j.permissions?.push; }
        else out.note = 'no token: fetch works for public repos; push and PRs need a token';
        return out;
      },
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      repos: { type: 'array', title: 'Repos to expose', items: { type: 'string', 'x-options-from': 'repos' }, 'x-disabled-key': 'reposDisabled', default: [] },
      reposDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true, default: [] },
    },
  },
  defaultConfig: { repos: [] },

  create(ctx: PluginContext): PluginInstance {
    const cfg = ctx.config as Cfg, g = ctx.pluginConfig as GlobalCfg;
    const exposed = g.repos.filter((r) => cfg.repos.includes(r.name) && !(cfg.reposDisabled ?? []).includes(r.name)).map(withDefaults);
    for (const r of g.repos) rules.seen(r.name, featureList);

    const repoArg = z.string().optional().describe(exposed.length === 1 ? `Repo name (default "${exposed[0].name}")` : `Repo name: ${exposed.map((r) => r.name).join(', ')}`);
    const pick = (name?: string) => {
      if (!name && exposed.length === 1) return exposed[0];
      const r = exposed.find((x) => x.name === name);
      if (!r) throw new Error(`unknown repo "${name ?? ''}"; available: ${exposed.map((x) => x.name).join(', ') || 'none'}`);
      return r;
    };

    type Gate = (features: string[], summary: string, subject: Record<string, unknown>) => Promise<string>;
    /** A tool on one repo: rules checked by `gate` inside, the call logged with who allowed it. */
    const tool = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, fn: (r: RepoCfg, args: any, call: ToolCallContext, gate: Gate) => Promise<unknown>): ToolDefinition => ({
      name, description, inputSchema: { repo: repoArg, ...inputSchema },
      annotations: { readOnlyHint: RO[name], destructiveHint: !RO[name], openWorldHint: true },
      async handler(args, call) {
        const r = pick(args.repo);
        const entry: LogEntry = { serverId: ctx.serverId, instance: ctx.instanceName, principal: call.principal, upstream: r.name, tool: name, args };
        const t0 = Date.now();
        let allowedBy: string | undefined, gated = false;
        const gate: Gate = async (features, summary, subject) => {
          gated = true;
          allowedBy = await rules.gate(call, entry, RO[name], { feature: 'github_tool', summary: `${r.name}: ${summary}`, subject: { upstream: r.name, tool: name, features, ...subject } },
            features.map((f) => ({ tool: f, readOnly: RO[f] })));
          gated = false;
          return allowedBy;
        };
        const rec = (e: Partial<LogEntry>) => { try { rules.record({ ...entry, allowedBy, ms: Date.now() - t0, ...e }); } catch (err) { ctx.log.warn(`call log write failed: ${(err as Error).message}`); } };
        try {
          const out = await fn(r, args, call, gate);
          rec({});
          return text(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
        } catch (e) {
          if (!gated) rec({ error: String((e as Error).message ?? e).slice(0, 500) }); // refusals were logged by the gate
          throw e;
        }
      },
    });

    const tools: ToolDefinition[] = [
      {
        name: 'repos', description: 'Repos you can work on through MControlProgram, with their agent branch prefix and PR base branches.',
        inputSchema: {}, annotations: { readOnlyHint: true },
        handler: () => text(JSON.stringify(exposed.map((r) => ({ name: r.name, url: r.url, description: r.description, branchPrefix: r.branchPrefix, baseBranches: r.baseBranches, sensitivePaths: r.askPaths })), null, 2)),
      },
      tool('resolve', 'Fetch the repo, then give the commit sha of `ref` (branch, tag or sha) so you can `git fetch && git checkout <sha>` in your read-only clone and work on exactly what MControlProgram has. Without `ref`: list branches and tags with their shas and the default branch.',
        { ref: z.string().optional().describe('Branch, tag or commit sha') },
        async (r, { ref }, call, gate) => {
          await gate(['resolve'], `resolve ${ref ?? '(list)'}`, { ref });
          await sync(r, call.signal);
          if (ref) {
            const sha = await commitOf(r, ref);
            if (!sha) throw new Error(`"${ref}" is not a branch, tag or commit on the remote`);
            return { ref, sha };
          }
          const lines = (await git(r, ['--git-dir', mirror(r), 'for-each-ref', '--format=%(refname)%09%(objectname)%09%(*objectname)', 'refs/heads', 'refs/tags'])).trim().split('\n').filter(Boolean);
          const refs = lines.map((l) => { const [n, o, peeled] = l.split('\t'); return { n, sha: peeled || o }; });
          const pick2 = (p: string) => Object.fromEntries(refs.filter((x) => x.n.startsWith(p)).map((x) => [x.n.slice(p.length), x.sha]));
          return { defaultBranch: await defaultBranch(r), branches: pick2('refs/heads/'), tags: pick2('refs/tags/') };
        }),
      tool('submit_patch', 'Apply your change on `base` (the commit you started from, see resolve), commit it and push it to an agent branch. `patch` is `git format-patch --stdout <base>` output (keeps your commits and messages; preferred) or a plain `git diff` plus `message`. Pushing over a branch you pushed before needs it to fast-forward, else `force: true`. Returns the pushed sha: `git fetch origin <branch>` to sync. Binary files need `format-patch --binary`.',
        {
          base: z.string().describe('Commit sha (or branch/tag) the patch was made on'),
          patch: z.string().describe('git format-patch --stdout output, or a unified git diff'),
          branch: z.string().describe('Agent branch to push to; the repo prefix is added if missing'),
          message: z.string().optional().describe('Commit message, required for a plain diff'),
          force: z.boolean().optional().describe('Allow rewriting the branch (not a fast-forward)'),
        },
        async (r, a, call, gate) => {
          if (Buffer.byteLength(a.patch) > r.maxPatchKB * 1024) throw new Error(`patch is over ${r.maxPatchKB} KB`);
          const branch = agentBranch(r, a.branch);
          await sync(r, call.signal);
          const res = await apply(r, { base: a.base, patch: a.patch, branch, message: a.message, principal: call.principal }, call.signal);
          try {
            if (res.force && !a.force) throw new Error(`${branch} is at ${res.previous}, which your commits don't build on. Rebase onto it (resolve ${branch}), or pass force: true to replace it.`);
            const sensitive = res.files.filter((f) => r.askPaths.some((p) => globMatch(p, f)));
            const features = ['submit_patch', ...(res.force ? ['force_push'] : []), ...(sensitive.length ? ['sensitive_paths'] : [])];
            const what = `${res.force ? 'force-push' : 'push'} ${res.commits} commit(s) to ${branch}: ${res.files.length} file(s)${sensitive.length ? `, sensitive: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}` : ''}`;
            const by = await gate(features, what, { branch, base: res.base, patch: createHash('sha256').update(a.patch).digest('hex').slice(0, 16), force: res.force });
            await res.push();
            ctx.log.info(`${r.name}: ${what} (${res.sha.slice(0, 12)}) for ${call.principal ?? 'agent'}, ${by}`);
            return { branch, sha: res.sha, base: res.base, commits: res.commits, files: res.files, forced: res.force, sync: `git fetch origin ${branch} && git checkout ${res.sha}` };
          } finally { await res.done(); }
        }),
      tool('create_pr', 'Open a pull request from an agent branch (push it with submit_patch first). If one is already open for the branch, returns it.',
        {
          branch: z.string().describe('Agent branch (head)'),
          base: z.string().optional().describe('Target branch; default: the first base branch, else the default branch'),
          title: z.string(), body: z.string().optional(), draft: z.boolean().optional(),
        },
        async (r, a, call, gate) => {
          const head = agentBranch(r, a.branch);
          const base = a.base ?? r.baseBranches[0] ?? await defaultBranch(r);
          if (!base) throw new Error('no base branch: pass base');
          if (r.baseBranches.length && !r.baseBranches.includes(base)) throw new Error(`base must be one of: ${r.baseBranches.join(', ')}`);
          await gate(['create_pr'], `PR ${head} → ${base}: ${a.title}`, { head, base, title: a.title });
          const owner = slug(r).split('/')[0];
          try {
            return prSummary(await gh(r, 'POST', '/pulls', { title: a.title, head, base, body: a.body ?? '', draft: !!a.draft }, call.signal));
          } catch (e: any) {
            if (e.status !== 422 || !/already exists/i.test(JSON.stringify(e.body ?? ''))) throw e;
            const open = await gh(r, 'GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, undefined, call.signal);
            if (!open[0]) throw e;
            return { ...prSummary(open[0]), existing: true };
          }
        }),
      tool('pr', 'Without `number`: list pull requests. With `number`: the PR with its checks, reviews and comments.',
        { number: z.number().int().optional(), state: z.enum(['open', 'closed', 'all']).optional().describe('For the list; default open') },
        async (r, a, call, gate) => {
          await gate(['pr'], a.number ? `read PR #${a.number}` : 'list PRs', { number: a.number });
          const s = call.signal;
          if (!a.number) return (await gh(r, 'GET', `/pulls?state=${a.state ?? 'open'}&per_page=50`, undefined, s)).map(prSummary);
          const p = await gh(r, 'GET', `/pulls/${a.number}`, undefined, s);
          const [checks, status, reviews, comments, inline] = await Promise.all([
            gh(r, 'GET', `/commits/${p.head.sha}/check-runs?per_page=100`, undefined, s).catch(() => ({ check_runs: [] })),
            gh(r, 'GET', `/commits/${p.head.sha}/status`, undefined, s).catch(() => ({ statuses: [] })),
            gh(r, 'GET', `/pulls/${a.number}/reviews?per_page=100`, undefined, s),
            gh(r, 'GET', `/issues/${a.number}/comments?per_page=100`, undefined, s),
            gh(r, 'GET', `/pulls/${a.number}/comments?per_page=100`, undefined, s),
          ]);
          return {
            ...prSummary(p), headSha: p.head.sha, mergeable: p.mergeable, mergeableState: p.mergeable_state, body: p.body,
            checks: [...checks.check_runs.map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
              ...status.statuses.map((c: any) => ({ name: c.context, status: 'completed', conclusion: c.state, url: c.target_url }))],
            reviews: reviews.map((x: any) => ({ user: x.user?.login, state: x.state, body: x.body })),
            comments: comments.map((x: any) => ({ user: x.user?.login, at: x.created_at, body: x.body })),
            inline: inline.map((x: any) => ({ user: x.user?.login, path: x.path, line: x.line, body: x.body })),
          };
        }),
      tool('comment', 'Comment on a pull request or issue.', { number: z.number().int(), body: z.string() },
        async (r, a, call, gate) => {
          await gate(['comment'], `comment on #${a.number}`, { number: a.number, body: a.body });
          const c = await gh(r, 'POST', `/issues/${a.number}/comments`, { body: a.body }, call.signal);
          return { url: c.html_url };
        }),
    ];

    return {
      tools,
      instructions: 'Git via MControlProgram: your clone is read-only. {prefix}_resolve gives the sha to check out; make commits locally, then send `git format-patch --stdout <base>` with {prefix}_submit_patch (base = that sha), fetch the returned branch, and open a PR with {prefix}_create_pr.',
      status: () => ({ repos: exposed.map((r) => ({ name: r.name, mirrored: fs.existsSync(path.join(mirror(r), 'HEAD')) })) }),
    };
  },
};

const featureList = FEATURES.map((f) => ({ name: f.name, description: f.description, annotations: { readOnlyHint: f.ro } }));
const withDefaults = (r: RepoCfg): RepoCfg => ({
  ...r, committerName: r.committerName || 'MControlProgram', committerEmail: r.committerEmail || 'mcontrolprogram@users.noreply.github.com',
  branchPrefix: r.branchPrefix ?? 'agent/', baseBranches: r.baseBranches ?? [], askPaths: r.askPaths ?? ['.github/', 'CODEOWNERS'], maxPatchKB: r.maxPatchKB || 2048,
});
export default plugin;
