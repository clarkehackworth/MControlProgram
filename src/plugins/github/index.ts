/**
 * GitHub through MControlProgram: agents keep a read-only clone, MControlProgram works in clones on a **git host**
 * (an SSH host or this machine) that hold the push credential: an ssh key generated there, never seen by agents.
 * Repos are discovered in the host's repos directory and paired with MCP servers like any inventory.
 *
 * An agent pins its clone with `resolve`, sends a patch with the commit it was based on (`submit_patch`), and
 * MControlProgram applies, commits and pushes it to an agent branch, opens PRs and reads their state (REST API,
 * with the host's token).
 *
 * Every tool and git feature (force push, touching CI paths) is allow / ask / deny per repo, using mcp's rule store
 * (own `github_*` tables, same panel as the MCP pass-through). One call asks once, for everything it touches.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MControlProgramPlugin, PluginActionContext, PluginContext, PluginInstance, ScopedLogger, ToolCallContext, ToolDefinition } from '../../core/plugin-api.js';
import { text } from '../../core/plugin-api.js';
import type { McpApi } from '../mcp/index.js';
import type { ToolRuleStore, LogEntry } from '../mcp/rules.js';
import type { SshApi } from '../ssh/index.js';

export interface HostCfg {
  name: string; native?: boolean; sshHost?: string; description?: string; reposDir: string; sshKey: string;
  committerName: string; committerEmail: string; token?: string; apiUrl?: string;
}
export interface RepoCfg { name: string; host: string; path: string; url?: string; description?: string; branchPrefix: string; baseBranches: string[]; askPaths: string[]; maxPatchKB: number }
interface GlobalCfg { hosts: HostCfg[]; repos: RepoCfg[] }
interface Cfg { repos: string[]; reposDisabled?: string[] }
type Repo = RepoCfg & { h: HostCfg };

/** Tools and git features the rules apply to, per repo. `ro` = read-only (allowed under the read-only policy). */
export const FEATURES: { name: string; ro: boolean; description: string }[] = [
  { name: 'resolve', ro: true, description: 'Fetch, then resolve a branch, tag or sha to a commit, or list branches and tags' },
  { name: 'submit_patch', ro: false, description: 'Apply a patch on a base commit, commit it and push it to an agent branch' },
  { name: 'force_push', ro: false, description: 'submit_patch that rewrites an agent branch (not a fast-forward)' },
  { name: 'sensitive_paths', ro: false, description: "submit_patch touching the repo's sensitive paths (CI workflows, CODEOWNERS…)" },
  { name: 'create_pr', ro: false, description: 'Open a pull request from an agent branch' },
  { name: 'pr', ro: true, description: 'List pull requests, or read one: state, checks, reviews and comments' },
  { name: 'comment', ro: false, description: 'Comment on a pull request or issue' },
];
const RO = Object.fromEntries(FEATURES.map((f) => [f.name, f.ro]));
const featureList = FEATURES.map((f) => ({ name: f.name, description: f.description, annotations: { readOnlyHint: f.ro } }));

let rules: ToolRuleStore;

// ---- shell on the git host ----------------------------------------------------------------------------------

/** Single-quote for sh. */
export const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** A path for sh: `~/x` = the host user's home. */
export const qp = (p: string) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${q(p.slice(2))}` : q(p));

type Run = (h: HostCfg, script: string, log: ScopedLogger, input?: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
const local = (script: string, input?: string) => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
  const p = spawn('sh', ['-c', script], { stdio: 'pipe' });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
  p.on('error', (e) => resolve({ stdout, stderr: stderr + e.message, code: 127 }));
  p.on('close', (code) => resolve({ stdout, stderr, code }));
  p.stdin.on('error', () => {}).end(input ?? '');
});
/** Native hosts run the script here; ssh hosts via the ssh plugin (in `sh`, whatever the login shell). */
export const runner = (ssh: SshApi | undefined): Run => (h, script, log, input) => {
  if (h.native) return local(script, input);
  if (!h.sshHost) throw new Error(`git host "${h.name}" has no SSH host and is not native`);
  if (!ssh) throw new Error('the ssh plugin is not loaded');
  return ssh.exec(h.sshHost, `sh -c ${q(script)}`, log, input ?? '');
};
/** Run a script, return stdout; non-zero exit → error with its stderr. */
async function sh(run: Run, h: HostCfg, script: string, log: ScopedLogger, input?: string): Promise<string> {
  const r = await run(h, script, log, input);
  if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`), { code: r.code });
  return r.stdout;
}

/**
 * Environment and helpers every git script starts with: the host's key for ssh remotes, the bot identity,
 * no prompts, repo hooks off. `res REF` prints the commit of a remote branch, a tag, or a sha the remote has.
 */
const prelude = (h: HostCfg) => `set -e
K=${qp(h.sshKey)}
[ -f "$K" ] && export GIT_SSH_COMMAND="ssh -i \\"$K\\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
export GIT_TERMINAL_PROMPT=0 GIT_COMMITTER_NAME=${q(h.committerName)} GIT_COMMITTER_EMAIL=${q(h.committerEmail)} GIT_AUTHOR_NAME=${q(h.committerName)} GIT_AUTHOR_EMAIL=${q(h.committerEmail)}
g() { git -c core.hooksPath=/dev/null -c protocol.ext.allow=never "$@"; }
res() {
  case "$1" in -*|'') return 1;; esac
  g rev-parse -q --verify "refs/remotes/origin/$1^{commit}" 2>/dev/null && return
  g rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null && return
  printf %s "$1" | grep -Eq '^[0-9a-f]{4,40}$' || return 1
  c=$(g rev-parse -q --verify "$1^{commit}" 2>/dev/null) || return 1
  [ -n "$(g for-each-ref --contains "$c" --count=1 refs/remotes/origin refs/tags)" ] && echo "$c"
}
fetch() { g fetch -q --prune --tags --force origin; }
`;

// ponytail: one script at a time per repo (git locks refs); approval waits happen outside the lock
const locks = new Map<string, Promise<unknown>>();
function locked<T>(r: Repo, fn: () => Promise<T>): Promise<T> {
  const k = `${r.host}\0${r.path}`;
  const next = (locks.get(k) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(k, next);
  return next.finally(() => { if (locks.get(k) === next) locks.delete(k); });
}

/** The agent branch for `branch`: the repo's prefix added when missing; never a base branch. */
export function agentBranch(r: Pick<RepoCfg, 'branchPrefix' | 'baseBranches'>, branch: string): string {
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

const REF = /^[^-\s][^\s]*$/;
const ref = (s: string) => { if (!REF.test(s)) throw new Error(`invalid ref "${s}"`); return s; };

interface Applied { base: string; sha: string; previous?: string; force: boolean; commits: number; files: string[] }
/** Fetch, then apply `patch` on `base` in a throwaway worktree and commit it. Nothing is pushed; the commit stays in the repo's objects. */
async function apply(run: Run, r: Repo, a: { base: string; patch: string; branch: string; message?: string; principal?: string }, log: ScopedLogger): Promise<Applied> {
  const mbox = isMbox(a.patch);
  if (!mbox && !a.message?.trim()) throw new Error('a plain diff needs a commit message (or send `git format-patch` output)');
  const commit = `g commit -q --no-gpg-sign -m ${q(a.message ?? '')}${a.principal ? ` --trailer ${q(`Submitted-by: ${a.principal} via MControlProgram`)}` : ''}`;
  const script = `${prelude(r.h)}P=$(mktemp); trap 'rm -f "$P"' EXIT; cat > "$P"
cd ${qp(r.path)}
fetch
base=$(res ${q(ref(a.base))}) || { echo "base not on the remote" >&2; exit 3; }
prev=$(g rev-parse -q --verify ${q(`refs/remotes/origin/${a.branch}`)} || true)
repo=$(pwd)
wt="$(g rev-parse --absolute-git-dir)/mcontrolprogram-work/${randomUUID()}"
g worktree add -q --detach "$wt" "$base"
trap 'rm -f "$P"; cd "$repo"; g worktree remove --force "$wt" >/dev/null 2>&1 || { rm -rf "$wt"; g worktree prune; }' EXIT
cd "$wt"
${mbox ? 'g am -q --3way --no-gpg-sign < "$P" || { g am --abort >/dev/null 2>&1 || true; exit 4; }' : `g apply --index --3way --whitespace=nowarn < "$P" || exit 4\n${commit}`}
sha=$(g rev-parse HEAD)
[ "$sha" != "$base" ] || { echo "the patch changes nothing" >&2; exit 5; }
force=0
if [ -n "$prev" ] && [ "$prev" != "$sha" ] && ! g merge-base --is-ancestor "$prev" "$sha"; then force=1; fi
printf 'base=%s\\nsha=%s\\nprev=%s\\nforce=%s\\ncommits=%s\\n--files--\\n' "$base" "$sha" "$prev" "$force" "$(g rev-list --count "$base..$sha")"
g diff --name-only -z "$base" "$sha"
`;
  const res = await locked(r, () => run(r.h, script, log, a.patch));
  if (res.code === 3) throw new Error(`base "${a.base}" is not on the remote. Base the patch on a pushed commit (see resolve) and include every commit since then.`);
  if (res.code === 4) throw new Error(`the patch does not apply: ${res.stderr.trim()}\nresolve the base branch's current commit, rebase onto it and submit again`);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
  const [head, files = ''] = res.stdout.split('--files--\n');
  const kv = Object.fromEntries(head.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { base: kv.base, sha: kv.sha, previous: kv.prev || undefined, force: kv.force === '1', commits: Number(kv.commits), files: files.split('\0').filter(Boolean) };
}

/** Push `sha` to `branch`; the lease fails the push if the branch moved since apply looked, instead of overwriting it. */
const push = (run: Run, r: Repo, x: Applied, branch: string, log: ScopedLogger) => locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}
g push -q --no-verify ${q(`--force-with-lease=refs/heads/${branch}:${x.previous ?? ''}`)} origin ${q(`${x.sha}:refs/heads/${branch}`)}
g update-ref ${q(`refs/remotes/origin/${branch}`)} ${q(x.sha)}
`, log));

// ---- repo discovery and host setup --------------------------------------------------------------------------

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Working clones directly under the repos dir: `dir \t absolute path \t origin url`. */
const scanScript = (h: HostCfg) => `D=${qp(h.reposDir)}
[ -d "$D" ] || exit 0
cd "$D"
for d in */; do
  d=\${d%/}
  [ -e "$d/.git" ] || continue
  printf '%s\\t%s\\t%s\\n' "$d" "$(cd "$d" && pwd -P)" "$(git -C "$d" remote get-url origin 2>/dev/null || true)"
done
`;

const repoDefaults = { branchPrefix: 'agent/', baseBranches: [] as string[], askPaths: ['.github/', 'CODEOWNERS'], maxPatchKB: 1024 };

/**
 * Bring the `repos` inventory in line with what is on the hosts (all, or `only`): new clones are added, ones gone
 * from a reachable host are dropped (with their server pairings), the rest keep their settings. Saves only on change.
 */
export async function scan(run: Run, a: Pick<PluginActionContext, 'config' | 'setConfig' | 'log'>, only?: string) {
  const g = withDefaults(a.config);
  const repos = g.repos.map((r) => ({ ...r }));
  const added: string[] = [], removed: string[] = [], errors: Record<string, string> = {};
  for (const h of g.hosts.filter((x) => !only || x.name === only)) {
    let found: { dir: string; path: string; url: string }[];
    try {
      found = (await sh(run, h, scanScript(h), a.log)).split('\n').filter(Boolean).map((l) => { const [dir, p, url] = l.split('\t'); return { dir, path: p, url }; });
    } catch (e) { errors[h.name] = (e as Error).message; continue; }
    for (let i = repos.length - 1; i >= 0; i--) if (repos[i].host === h.name && !found.some((f) => f.path === repos[i].path)) removed.push(...repos.splice(i, 1).map((x) => x.name));
    for (const f of found) {
      const r = repos.find((x) => x.host === h.name && x.path === f.path);
      if (r) { if (f.url && r.url !== f.url) r.url = f.url; continue; }
      const base = f.dir.replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '_');
      let name = repos.some((x) => x.name === base) ? `${h.name}-${base}` : base;
      for (let n = 2; repos.some((x) => x.name === name); n++) name = `${h.name}-${base}-${n}`;
      repos.push({ name, host: h.name, path: f.path, url: f.url || undefined, ...repoDefaults });
      added.push(name);
    }
  }
  if (JSON.stringify(repos) !== JSON.stringify(g.repos)) await a.setConfig({ ...a.config, repos });
  return { repos: repos.filter((r) => !only || r.host === only).map((r) => r.name), added, removed, errors };
}

/** git present, repos dir and ssh key created if missing; the public key to add to GitHub, and whether GitHub accepts it. */
async function setupHost(run: Run, h: HostCfg, log: ScopedLogger) {
  const out = await sh(run, h, `set -e
command -v git >/dev/null || { echo "git is not installed on this host" >&2; exit 2; }
echo "git=$(git --version)"
K=${qp(h.sshKey)}
mkdir -p "$(dirname "$K")" ${qp(h.reposDir)}
chmod 700 "$(dirname "$K")" 2>/dev/null || true
[ -f "$K" ] || { ssh-keygen -q -t ed25519 -N '' -C "mcontrolprogram-git@$(hostname)" -f "$K" && echo "created=1"; }
echo "pub=$(cat "$K.pub")"
echo "github=$(ssh -i "$K" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -T git@github.com 2>&1 | grep -E '^Hi |denied' | head -1 || true)"
`, log);
  const kv = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { git: kv.git, keyCreated: !!kv.created, publicKey: kv.pub, github: kv.github || 'no answer from github.com (blocked network?)' };
}

/** Clone `url` into the host's repos dir with the host's key. */
async function clone(run: Run, h: HostCfg, url: string, name: string | undefined, log: ScopedLogger) {
  if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/)[^\s'"]+$/.test(url)) throw new Error('clone URL must be https://, ssh://, git@host:owner/repo or file://');
  const dir = name || url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '');
  if (!NAME.test(dir)) throw new Error(`invalid directory name "${dir}"`);
  await sh(run, h, `${prelude(h)}mkdir -p ${qp(h.reposDir)} && cd ${qp(h.reposDir)}
[ ! -e ${q(dir)} ] || { echo "${dir} already exists in the repos directory" >&2; exit 2; }
g clone -q ${q(url)} ${q(dir)}
`, log);
  return dir;
}

// ---- GitHub REST --------------------------------------------------------------------------------------------

/** owner/repo from the origin URL's last two path segments (https or scp-style). */
export const slug = (r: Pick<RepoCfg, 'name' | 'url'>) => {
  const m = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.url ?? '');
  if (!m) throw new Error(`cannot tell owner/repo from origin "${r.url ?? ''}" of ${r.name}`);
  return `${m[1]}/${m[2]}`;
};
async function gh(r: Repo, method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  if (!r.h.token) throw new Error(`git host "${r.h.name}" has no GitHub token; PRs and comments need one`);
  const res = await fetch(`${(r.h.apiUrl || 'https://api.github.com').replace(/\/$/, '')}/repos/${slug(r)}${p}`, {
    method, signal, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${r.h.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MControlProgram', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${p}: ${res.status} ${j?.message ?? res.statusText}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`.split(r.h.token).join('***')), { status: res.status, body: j });
  return j;
}
const prSummary = (p: any) => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: p.draft, head: p.head?.ref, base: p.base?.ref, url: p.html_url, user: p.user?.login, updated: p.updated_at });

// ---- plugin -------------------------------------------------------------------------------------------------

const hostSchema = {
  type: 'object',
  required: ['name'],
  'x-kind-column': { title: 'Type', flags: { native: 'Native' }, default: 'SSH' },
  properties: {
    name: { type: 'string', title: 'Name', pattern: '^[a-zA-Z0-9_.-]+$', 'x-pattern-hint': 'letters, digits, _ . -' },
    native: { type: 'boolean', title: 'Native (this machine)', default: false, description: 'Run git on the machine MControlProgram runs on (inside its container if it is containerised), without ssh. Paths and ~ are the MControlProgram user\'s.' },
    sshHost: { type: 'string', title: 'SSH host', description: 'Host from the SSH plugin inventory (pinned host key) with git installed. Commands run as that user. Not used for native hosts.', 'x-options-from': 'ssh:hosts' },
    reposDir: { type: 'string', title: 'Repos directory', description: 'Clones directly under it are picked up as repos. ~/ = the host user\'s home. Native host in a container: use a path on the data volume (e.g. /data/github/repos, and SSH key /data/github/id_ed25519) so clones and key survive rebuilds.', default: '~/mcontrolprogram-repos' },
    description: { type: 'string', title: 'Description', 'x-no-column': true },
    sshKey: { type: 'string', title: 'SSH key', description: 'Private key on the host for pushing over ssh; "Set up host" creates it. Add its public key to GitHub as a deploy key with write access (one repo) or to a machine user.', default: '~/.ssh/mcontrolprogram_git', 'x-no-column': true },
    committerName: { type: 'string', title: 'Committer name', default: 'MControlProgram', 'x-no-column': true },
    committerEmail: { type: 'string', title: 'Committer email', default: 'mcontrolprogram@users.noreply.github.com', 'x-no-column': true },
    token: { type: 'string', title: 'GitHub token', 'x-secret': true, 'x-no-column': true, description: 'For PRs and comments (REST API): fine-grained token with Pull requests read & write on these repos. Kept by MControlProgram, never sent to the host or agents. Empty = git only.' },
    apiUrl: { type: 'string', title: 'API URL', 'x-no-column': true, description: 'Empty = https://api.github.com (GitHub Enterprise: https://host/api/v3)' },
  },
};
const repoSchema = {
  type: 'object',
  required: ['name', 'host', 'path'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'What agents call the repo', pattern: '^[a-zA-Z0-9_.-]+$', 'x-pattern-hint': 'letters, digits, _ . -' },
    host: { type: 'string', title: 'Git host', 'x-options-from': 'hosts' },
    path: { type: 'string', title: 'Path', description: 'Clone on the host (found by scanning its repos directory)', 'x-no-column': true },
    url: { type: 'string', title: 'Origin', description: 'Found by scanning' },
    description: { type: 'string', title: 'Description', description: 'Shown to agents', 'x-no-column': true },
    branchPrefix: { type: 'string', title: 'Agent branch prefix', description: 'Agents push only to branches starting with this', default: 'agent/', 'x-no-column': true },
    baseBranches: { type: 'array', title: 'Base branches', description: 'PR targets; never pushed to. Empty = the default branch.', items: { type: 'string' }, default: [], 'x-no-column': true },
    askPaths: { type: 'array', title: 'Sensitive paths', description: 'Patches touching these use the sensitive_paths rule (** any path, * one component; a plain path covers everything under it)', items: { type: 'string' }, default: ['.github/', 'CODEOWNERS'], 'x-no-column': true },
    maxPatchKB: { type: 'integer', title: 'Max patch size (KB)', default: 1024, 'x-no-column': true },
  },
};

const plugin: MControlProgramPlugin = {
  id: 'github',
  name: 'GitHub',
  version: '0.2.0',
  navOrder: 35,
  dependencies: { mcp: '^0.2.0', ssh: '^0.2.1' },
  description: 'Agents with a read-only clone sync to the same commit and submit patches; MControlProgram applies, commits and pushes them from clones on a git host (SSH or this machine) and opens PRs. Every tool and git feature is allow / ask / deny per repo.',
  init(h) { rules = h.dep<McpApi>('mcp').toolRuleStore(() => h.db, 'github', { defaultPolicy: 'readonly' }); },
  globalConfigSchema: {
    type: 'object',
    properties: {
      hosts: { type: 'array', title: 'Git hosts', items: hostSchema, default: [], 'x-referenced-by': { inventory: 'repos', field: 'host', title: 'Repos' } },
      repos: { type: 'array', title: 'Repos', items: repoSchema, default: [] },
    },
  },
  defaultGlobalConfig: { hosts: [], repos: [] },
  onRenamed: (key, from, to) => { if (key === 'repos') rules.renameUpstream(from, to); },
  globalActions: {
    // the shared rules panel's actions; `rules` exists once init ran
    ...Object.fromEntries((['set_tool_rule', 'set_policy', 'calls', 'clear_calls'] as const).map((k) => [k, { hidden: true, title: k, run: (p: any) => rules.actions[k].run(p) }])),
    // the feature list is fixed: list it for every repo, so the panel shows repos no server exposes yet
    tool_rules: { hidden: true, title: 'Tool rules', run: async (_p, a) => { for (const r of withDefaults(a.config).repos) rules.seen(r.name, featureList); return rules.actions.tool_rules.run(); } },
    setup_host: {
      title: 'Set up host', inventory: 'hosts',
      async run({ name }, a) {
        const h = hostOf(withDefaults(a.config), name);
        const run = runner(a.dep<SshApi>('ssh'));
        const setup = await setupHost(run, h, a.log);
        return { ...setup, ...(await scan(run, a, h.name)), next: setup.github.startsWith('Hi ') ? undefined : 'Add publicKey to GitHub: a deploy key with write access (repo Settings → Deploy keys) or an SSH key of a machine user, then run Set up host again.' };
      },
    },
    scan: { title: 'Rescan repos', inventory: 'hosts', async run({ name }, a) { return scan(runner(a.dep<SshApi>('ssh')), a, name || undefined); } },
    clone: {
      title: 'Clone repo', hidden: true,
      async run({ host, url, name }, a) {
        const run = runner(a.dep<SshApi>('ssh'));
        const dir = await clone(run, hostOf(withDefaults(a.config), host), String(url ?? '').trim(), name ? String(name) : undefined, a.log);
        return { dir, ...(await scan(run, a, host)) };
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
    const cfg = ctx.config as Cfg, g = withDefaults(ctx.pluginConfig);
    const run = runner(ctx.dep<SshApi>('ssh'));
    const exposed: Repo[] = g.repos.filter((r) => cfg.repos.includes(r.name) && !(cfg.reposDisabled ?? []).includes(r.name))
      .flatMap((r) => { const h = g.hosts.find((x) => x.name === r.host); if (!h) ctx.log.warn(`repo ${r.name}: git host "${r.host}" is not configured`); return h ? [{ ...r, h }] : []; });
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
    const tool = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, fn: (r: Repo, args: any, call: ToolCallContext, gate: Gate) => Promise<unknown>): ToolDefinition => ({
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
        name: 'repos', description: 'Repos you can work on through MControlProgram: origin URL to clone read-only, agent branch prefix, PR base branches and sensitive paths.',
        inputSchema: {}, annotations: { readOnlyHint: true },
        handler: () => text(JSON.stringify(exposed.map((r) => ({ name: r.name, origin: r.url, description: r.description, branchPrefix: r.branchPrefix, baseBranches: r.baseBranches, sensitivePaths: r.askPaths })), null, 2)),
      },
      tool('resolve', 'Fetch the repo, then give the commit sha of `ref` (branch, tag or sha) so you can `git fetch && git checkout <sha>` in your read-only clone and work on exactly what MControlProgram has. Without `ref`: list branches and tags with their shas and the default branch.',
        { ref: z.string().optional().describe('Branch, tag or commit sha') },
        async (r, a, call, gate) => {
          await gate(['resolve'], `resolve ${a.ref ?? '(list)'}`, { ref: a.ref });
          if (a.ref) {
            const out = await locked(r, () => run(r.h, `${prelude(r.h)}cd ${qp(r.path)}\nfetch\nres ${q(ref(a.ref))}`, call.log));
            if (out.code !== 0) throw new Error(out.stderr.trim() || `"${a.ref}" is not a branch, tag or commit on the remote`);
            return { ref: a.ref, sha: out.stdout.trim() };
          }
          const out = await locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}\nfetch
echo "default=$(g symbolic-ref -q --short refs/remotes/origin/HEAD || true)"
g for-each-ref --format='%(refname)%09%(objectname)%09%(*objectname)' refs/remotes/origin refs/tags`, call.log));
          const [first, ...lines] = out.trim().split('\n');
          const refs = lines.filter(Boolean).map((l) => { const [n, o, peeled] = l.split('\t'); return { n, sha: peeled || o }; }).filter((x) => x.n !== 'refs/remotes/origin/HEAD');
          const under = (p: string) => Object.fromEntries(refs.filter((x) => x.n.startsWith(p)).map((x) => [x.n.slice(p.length), x.sha]));
          return { defaultBranch: first.replace(/^default=(origin\/)?/, '') || undefined, branches: under('refs/remotes/origin/'), tags: under('refs/tags/') };
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
          const x = await apply(run, r, { base: a.base, patch: a.patch, branch, message: a.message, principal: call.principal }, call.log);
          if (x.force && !a.force) throw new Error(`${branch} is at ${x.previous}, which your commits don't build on. Rebase onto it (resolve ${branch}), or pass force: true to replace it.`);
          const sensitive = x.files.filter((f) => r.askPaths.some((p) => globMatch(p, f)));
          const features = ['submit_patch', ...(x.force ? ['force_push'] : []), ...(sensitive.length ? ['sensitive_paths'] : [])];
          const what = `${x.force ? 'force-push' : 'push'} ${x.commits} commit(s) to ${branch}: ${x.files.length} file(s)${sensitive.length ? `, sensitive: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}` : ''}`;
          const by = await gate(features, what, { branch, base: x.base, patch: createHash('sha256').update(a.patch).digest('hex').slice(0, 16), force: x.force });
          await push(run, r, x, branch, call.log);
          ctx.log.info(`${r.name}: ${what} (${x.sha.slice(0, 12)}) for ${call.principal ?? 'agent'}, ${by}`);
          return { branch, sha: x.sha, base: x.base, commits: x.commits, files: x.files, forced: x.force, sync: `git fetch origin ${branch} && git checkout ${x.sha}` };
        }),
      tool('create_pr', 'Open a pull request from an agent branch (push it with submit_patch first). If one is already open for the branch, returns it.',
        {
          branch: z.string().describe('Agent branch (head)'),
          base: z.string().optional().describe('Target branch; default: the first base branch, else the default branch'),
          title: z.string(), body: z.string().optional(), draft: z.boolean().optional(),
        },
        async (r, a, call, gate) => {
          const head = agentBranch(r, a.branch);
          if (a.base && r.baseBranches.length && !r.baseBranches.includes(a.base)) throw new Error(`base must be one of: ${r.baseBranches.join(', ')}`);
          await gate(['create_pr'], `PR ${head} → ${a.base ?? r.baseBranches[0] ?? 'default branch'}: ${a.title}`, { head, base: a.base, title: a.title });
          const base = a.base ?? r.baseBranches[0] ?? (await gh(r, 'GET', '', undefined, call.signal)).default_branch;
          try {
            return prSummary(await gh(r, 'POST', '/pulls', { title: a.title, head, base, body: a.body ?? '', draft: !!a.draft }, call.signal));
          } catch (e: any) {
            if (e.status !== 422 || !/already exists/i.test(JSON.stringify(e.body ?? ''))) throw e;
            const open = await gh(r, 'GET', `/pulls?state=open&head=${encodeURIComponent(`${slug(r).split('/')[0]}:${head}`)}`, undefined, call.signal);
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
      status: () => ({ repos: exposed.map((r) => ({ name: r.name, host: r.host, origin: r.url })) }),
    };
  },
};

const hostOf = (g: GlobalCfg, name: unknown) => { const h = g.hosts.find((x) => x.name === name); if (!h) throw new Error(`unknown git host "${String(name)}"`); return h; };
/** Config with defaults filled in (fields added later, or left empty in the form). */
function withDefaults(c: Record<string, any>): GlobalCfg {
  return {
    hosts: (c.hosts ?? []).map((h: HostCfg) => ({ ...h, reposDir: h.reposDir || '~/mcontrolprogram-repos', sshKey: h.sshKey || '~/.ssh/mcontrolprogram_git', committerName: h.committerName || 'MControlProgram', committerEmail: h.committerEmail || 'mcontrolprogram@users.noreply.github.com' })),
    repos: (c.repos ?? []).map((r: RepoCfg) => ({ ...repoDefaults, ...r, branchPrefix: r.branchPrefix ?? 'agent/', maxPatchKB: r.maxPatchKB || 1024 })),
  };
}
export default plugin;
