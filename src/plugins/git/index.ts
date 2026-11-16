/**
 * Git through MControlProgram: agents keep a read-only clone, MControlProgram works in clones on a **git host**
 * (an SSH host or this machine) that hold the push credential: an ssh key generated there, never seen by agents.
 * Any git server works. Repos are discovered in the host's repos directory and paired with MCP servers like any inventory.
 *
 * An agent pins its clone with `resolve`, sends a patch with the commit it was based on (`submit_patch`), and
 * MControlProgram applies, commits and pushes it to an agent branch. With a PR provider on the host (GitHub,
 * GitLab, Gitea / Forgejo) it also opens PRs and reads their state, with the host's API token (providers.ts).
 *
 * Agents can also use MControlProgram as a git remote (smart HTTP on the MCP server's port, per-agent token from
 * `clone_url`): fetch to see exactly what MControlProgram has, `git push` to have it forwarded to an agent branch.
 * It serves a bare mirror next to the host clone holding only origin's branches and tags plus agent pushes, so
 * the host clone's own work never leaks.
 *
 * Agents can also work in the host clone itself (`git`, `write_file`, `push` tools): pull, switch branches, merge / rebase,
 * stash, resolve conflicts and commit there, with an allowlist of git subcommands and options, then push like submit_patch.
 *
 * Every tool and git feature (force push, touching CI paths) is allow / ask / deny per repo, using mcp's rule store
 * (own `git_*` tables, same panel as the MCP pass-through). One call asks once, for everything it touches.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import type { HttpContext, MControlProgramPlugin, PluginActionContext, PluginContext, PluginInstance, ScopedLogger, ToolCallContext, ToolDefinition } from '../../core/plugin-api.js';
import { text } from '../../core/plugin-api.js';
import type { McpApi } from '../mcp/index.js';
import type { ToolRuleStore, LogEntry } from '../mcp/rules.js';
import type { Proc, SshApi } from '../ssh/index.js';
import { PROVIDERS, origin, provider, type ProviderName } from './providers.js';

export interface HostCfg {
  name: string; native?: boolean; sshHost?: string; description?: string; reposDir: string; sshKey: string;
  committerName: string; committerEmail: string; provider?: ProviderName; token?: string; apiUrl?: string;
}
export interface RepoCfg { name: string; host: string; path: string; url?: string; description?: string; branchPrefix: string; baseBranches: string[]; askPaths: string[]; maxPatchKB: number; assistTrailer: string }
interface GlobalCfg { hosts: HostCfg[]; repos: RepoCfg[] }
interface Cfg { repos: string[]; reposDisabled?: string[] }
type Repo = RepoCfg & { h: HostCfg };

/** Tools and git features the rules apply to, per repo. `ro` = read-only (allowed under the read-only policy). */
export const FEATURES: { name: string; ro: boolean; description: string }[] = [
  { name: 'resolve', ro: true, description: 'Fetch, then resolve a branch, tag or sha to a commit, or list branches and tags' },
  { name: 'clone_url', ro: true, description: "Get a git URL and token to clone / fetch the repo from MControlProgram (origin's branches and tags), and fetch with it" },
  { name: 'submit_patch', ro: false, description: 'Apply a patch on a base commit, commit it and push it to an agent branch' },
  { name: 'git_push', ro: false, description: "git push to MControlProgram's remote, forwarded to an agent branch (the agent's commits as they are, authors and committers included)" },
  { name: 'force_push', ro: false, description: 'submit_patch or git push that rewrites an agent branch (not a fast-forward)' },
  { name: 'custom_identity', ro: false, description: 'submit_patch or git push with an author / committer other than the git host\'s identity' },
  { name: 'sensitive_paths', ro: false, description: "submit_patch or git push touching the repo's sensitive paths (CI workflows, CODEOWNERS…)" },
  { name: 'create_pr', ro: false, description: 'Open a pull request (GitLab: merge request) from an agent branch' },
  { name: 'pr', ro: true, description: 'List pull requests, or read one: state, checks, reviews and comments' },
  { name: 'comment', ro: false, description: 'Comment on a pull request (GitHub, Gitea: or an issue)' },
  { name: 'merge_pr', ro: false, description: 'Merge a pull request (merge, squash or rebase)' },
  { name: 'edit_pr', ro: false, description: 'Edit a pull request: title, body, base, close / reopen, draft, labels, assignees, reviewers' },
  { name: 'review_pr', ro: false, description: 'Review a pull request: approve, request changes or comment' },
  { name: 'base_push', ro: false, description: 'submit_patch or git push straight to a base branch, without a PR' },
  { name: 'delete_branch', ro: false, description: 'Delete an agent branch on the remote (also merge_pr with delete_branch)' },
  { name: 'workdir_read', ro: true, description: "git status / log / diff / show … in MControlProgram's clone (the git tool's read-only commands)" },
  { name: 'workdir', ro: false, description: "Change MControlProgram's clone: pull, switch branches, merge / rebase, stash, commit, resolve conflicts (git and write_file tools)" },
  { name: 'push', ro: false, description: "Push a branch prepared in MControlProgram's clone to an agent branch (base_push, force_push, custom_identity and sensitive_paths apply too)" },
];
const RO = Object.fromEntries(FEATURES.map((f) => [f.name, f.ro]));
const featureList = FEATURES.map((f) => ({ name: f.name, description: f.description, annotations: { readOnlyHint: f.ro } }));

let rules: ToolRuleStore;
let db: () => BetterSqlite3.Database;

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
type Spawn = (h: HostCfg, script: string, log: ScopedLogger) => Promise<Proc>;
/** Like `runner`, with streaming binary stdin/stdout (git's wire protocol). */
export const spawner = (ssh: SshApi | undefined): Spawn => async (h, script, log) => {
  if (h.native) {
    const p = spawn('sh', ['-c', script], { stdio: 'pipe' });
    return { stdin: p.stdin, stdout: p.stdout, stderr: p.stderr, done: new Promise((r) => { p.on('close', r); p.on('error', () => r(127)); }), kill: () => p.kill('SIGKILL') };
  }
  if (!h.sshHost) throw new Error(`git host "${h.name}" has no SSH host and is not native`);
  if (!ssh) throw new Error('the ssh plugin is not loaded');
  return ssh.spawn(h.sshHost, `sh -c ${q(script)}`, log);
};
/** Feed `input`, collect stdout as bytes. */
async function collect(p: Proc, input?: Buffer) {
  const out: Buffer[] = []; let err = '';
  p.stdout.on('data', (d: Buffer) => out.push(d)); p.stderr.on('data', (d: Buffer) => (err += d));
  p.stdin.on('error', () => {}); p.stdin.end(input);
  const code = await p.done;
  return { out: Buffer.concat(out), err, code };
}

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
# the bare mirror agents fetch from and push to (when someone used clone_url): origin's branches and tags only
sv() { echo "$(g rev-parse --absolute-git-dir)/mcontrolprogram-serve.git"; }
sync() {
  S=$(sv); [ -d "$S" ] || return 0
  g -C "$S" fetch -q --prune --force "$(pwd)" '+refs/remotes/origin/*:refs/heads/*' '^refs/remotes/origin/HEAD' '+refs/tags/*:refs/tags/*'
  d=$(g symbolic-ref -q --short refs/remotes/origin/HEAD) && g -C "$S" symbolic-ref HEAD "refs/heads/\${d#origin/}" || true
}
fetch() { g fetch -q --prune --tags --force origin; sync; }
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
/** `<repo trailer>: <who>`: who the agent says it is, else its MCP client; none when the repo's trailer name is empty. */
export function assistTrailer(trailer: string, who?: string, client?: string): string | undefined {
  const ok = (w: string) => w.length <= 100 && !/[<>\p{Cc}]/u.test(w);
  if (who?.trim() && !ok(who.trim())) throw new Error('invalid assisted_by: one line, at most 100 characters, no < >');
  const w = who?.trim() || (client && ok(client.trim()) ? client.trim() : '');
  return trailer && w ? `${trailer}: ${w}` : undefined;
}

/** A committer identity from an agent: both fields, nothing that could break out of a header. */
export function identity(name?: string, email?: string): { name: string; email: string } | undefined {
  if (!name && !email) return undefined;
  if (!name?.trim() || !email?.trim()) throw new Error('committer_name and committer_email go together');
  const n = name.trim(), e = email.trim();
  if (n.length > 100 || /[<>\p{Cc}]/u.test(n)) throw new Error('invalid committer_name');
  if (e.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(e)) throw new Error('invalid committer_email');
  return { name: n, email: e };
}

async function apply(run: Run, r: Repo, a: { base: string; patch: string; branch: string; message?: string; principal?: string; ident?: { name: string; email: string }; assisted?: string }, log: ScopedLogger): Promise<Applied> {
  const mbox = isMbox(a.patch);
  if (!mbox && !a.message?.trim()) throw new Error('a plain diff needs a commit message (or send `git format-patch` output)');
  const assisted = a.assisted ? ` --trailer ${q(a.assisted)}` : '';
  const commit = `g commit -q --no-gpg-sign -m ${q(a.message ?? '')}${a.principal ? ` --trailer ${q(`Submitted-by: ${a.principal} via MControlProgram`)}` : ''}${assisted}`;
  // every commit is authored and committed by the host's identity (or the agent's, see custom_identity): a mailbox's
  // commits keep their messages but are re-signed, with the assisted-by trailer added
  const resign = `g rebase -q "$base" --exec ${q(`git -c core.hooksPath=/dev/null commit -q --amend --no-edit --no-verify --no-gpg-sign --reset-author${assisted}`)} >/dev/null || { g rebase --abort >/dev/null 2>&1 || true; exit 4; }`;
  const ident = a.ident ? `export GIT_COMMITTER_NAME=${q(a.ident.name)} GIT_COMMITTER_EMAIL=${q(a.ident.email)} GIT_AUTHOR_NAME=${q(a.ident.name)} GIT_AUTHOR_EMAIL=${q(a.ident.email)}\n` : '';
  const script = `${prelude(r.h)}${ident}P=$(mktemp); trap 'rm -f "$P"' EXIT; cat > "$P"
cd ${qp(r.path)}
fetch
base=$(res ${q(ref(a.base))}) || { echo "base not on the remote" >&2; exit 3; }
prev=$(g rev-parse -q --verify ${q(`refs/remotes/origin/${a.branch}`)} || true)
repo=$(pwd)
wt="$(g rev-parse --absolute-git-dir)/mcontrolprogram-work/${randomUUID()}"
g worktree add -q --detach "$wt" "$base"
trap 'rm -f "$P"; cd "$repo"; g worktree remove --force "$wt" >/dev/null 2>&1 || { rm -rf "$wt"; g worktree prune; }' EXIT
cd "$wt"
${mbox ? `g am -q --3way --no-gpg-sign < "$P" || { g am --abort >/dev/null 2>&1 || true; exit 4; }\n${resign}` : `g apply --index --3way --whitespace=nowarn < "$P" || exit 4\n${commit}`}
sha=$(g rev-parse HEAD)
[ "$sha" != "$base" ] || { echo "the patch changes nothing" >&2; exit 5; }
force=0
if [ -n "$prev" ] && [ "$prev" != "$sha" ] && ! g merge-base --is-ancestor "$prev" "$sha"; then force=1; fi
printf 'base=%s\\nsha=%s\\nprev=%s\\nforce=%s\\ncommits=%s\\n--files--\\n' "$base" "$sha" "$prev" "$force" "$(g rev-list --count "$base..$sha")"
g diff --name-only -z "$base" "$sha"
`;
  const res = await locked(r, () => run(r.h, script, log, a.patch));
  if (res.code === 3) throw new Error(`base "${a.base}" is not on the remote. Base the patch on a pushed commit (see resolve) and include every commit since then.`);
  if (res.code === 4) throw new Error(`the patch does not apply: ${res.stderr.trim()}\n${/blobs recorded in its index|lacks necessary blobs/.test(res.stderr)
    ? `the patch's starting content isn't in ${a.base}: it was made from something else (uncommitted changes, or commits since ${a.base} not in the patch). Commit everything, then send \`git format-patch --stdout ${a.base}\`.`
    : "resolve the base branch's current commit, rebase onto it and submit again"}`);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
  const [head, files = ''] = res.stdout.split('--files--\n');
  const kv = Object.fromEntries(head.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { base: kv.base, sha: kv.sha, previous: kv.prev || undefined, force: kv.force === '1', commits: Number(kv.commits), files: files.split('\0').filter(Boolean) };
}

// ---- MControlProgram's clone, driven by agents (git / write_file / push tools) ------------------------------

/** Subcommands agents may run in the host clone; the read ones fall under the read-only policy. No push (the push tool), config, remote, submodule, am. */
export const WT_READ = ['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'merge-base', 'describe', 'shortlog'];
export const WT_WRITE = ['pull', 'fetch', 'switch', 'checkout', 'restore', 'branch', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'add', 'rm', 'mv', 'commit', 'clean'];
/** Options that run commands, read or write files outside the repo, or reach other repos: long ones under any abbreviation git accepts. */
const WT_LONG = ['--exec', '--upload-pack', '--receive-pack', '--output', '--no-index', '--pathspec-from-file', '--file', '--template', '--contents', '--recurse-submodules', '--ignore-revs-file', '--open-files-in-pager'];
const WT_SHORT: Record<string, string> = { commit: 'Ft', merge: 'F', rebase: 'x' };
/** Throws unless `git <cmd> <args>` is allowed in the host clone. Errs on the side of refusing (e.g. `-mFix` reads as -F: use --message=). */
export function workdirCheck(cmd: string, args: string[]): void {
  if (![...WT_READ, ...WT_WRITE].includes(cmd)) throw new Error(`git ${cmd} is not available here; allowed: ${[...WT_READ, ...WT_WRITE].join(', ')} (push with the push tool)`);
  const pos: string[] = [];
  let dd = false;
  for (const a of args) {
    if (dd || !a.startsWith('-') || a === '-') { pos.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    const bad = a.startsWith('--') ? WT_LONG.some((o) => o.startsWith(a.split('=')[0])) : [...a.slice(1)].some((c) => (WT_SHORT[cmd] ?? '').includes(c));
    if (bad) throw new Error(`option ${a} is not allowed here`);
  }
  if ((cmd === 'pull' || cmd === 'fetch') && pos.length && pos[0] !== 'origin') throw new Error(`${cmd} from origin only (give option values as --opt=value)`);
}

/**
 * With $new (and $prev, the branch's current commit or empty) set: what pushing new over prev adds. Prints force,
 * commit count, author / committer identities, then the files. `dflt` = where new work forks from when there is no prev.
 */
const inspect = (dflt: string) => `force=0; if [ -n "$prev" ] && ! g merge-base --is-ancestor "$prev" "$new"; then force=1; fi
if [ -n "$prev" ] && [ $force = 0 ]; then base=$prev; else base=$(g merge-base "$new" ${dflt} 2>/dev/null || g hash-object -t tree /dev/null); fi
ids=$( { g log --format='%an <%ae>%n%cn <%ce>' "$new" --not "$base" 2>/dev/null || g log --format='%an <%ae>%n%cn <%ce>' "$new"; } | sort -u | tr '\\n' '\\t')
printf 'force=%s\\ncommits=%s\\nids=%s\\n--files--\\n' "$force" "$(g rev-list --count "$new" --not "$base" 2>/dev/null || g rev-list --count "$new")" "$ids"
g diff --name-only -z "$base" "$new"
`;
/** `inspect`'s output (after any `k=v` lines before it), with the sensitive files and identities other than the host's. */
function inspected(out: string, r: Repo) {
  const [head, list = ''] = out.split('--files--\n');
  const kv = Object.fromEntries(head.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const files = list.split('\0').filter(Boolean);
  return { kv, force: kv.force === '1', commits: kv.commits, files, sensitive: files.filter((f) => r.askPaths.some((p) => globMatch(p, f))),
    others: (kv.ids ?? '').split('\t').filter((x) => x && x !== `${r.h.committerName} <${r.h.committerEmail}>`) };
}

/** Push `sha` to `branch`; the lease fails the push if the branch moved since apply looked, instead of overwriting it. */
const push = (run: Run, r: Repo, x: Pick<Applied, 'sha' | 'previous'>, branch: string, log: ScopedLogger) => locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}
g push -q --no-verify ${q(`--force-with-lease=refs/heads/${branch}:${x.previous ?? ''}`)} origin ${q(`${x.sha}:refs/heads/${branch}`)}
g update-ref ${q(`refs/remotes/origin/${branch}`)} ${q(x.sha)}
sync
`, log));

// ---- git smart HTTP (protocol v0 only: v2 hands out any object by sha) --------------------------------------

export const pkt = (line: string | Buffer) => { const b = Buffer.from(line); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
/** pkt-lines up to the first flush; `rest` = what follows it (the pack). */
export function readPkts(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  for (let i = 0; i + 4 <= buf.length;) {
    const n = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (Number.isNaN(n) || (n > 0 && n < 4)) throw new Error('bad pkt-line');
    if (n === 0) return { lines, rest: buf.subarray(i + 4) };
    lines.push(buf.subarray(i + 4, i + n)); i += n;
  }
  return { lines, rest: Buffer.alloc(0) };
}
/** Drop capabilities from the first advertised ref (we parse plain report-status and forward ref by ref). */
export function stripCaps(adv: Buffer, drop: string[]): Buffer {
  const n = parseInt(adv.subarray(0, 4).toString(), 16);
  if (!n) return adv;
  const line = adv.subarray(4, n), z = line.indexOf(0);
  if (z < 0) return adv;
  const caps = line.subarray(z + 1).toString().trim().split(' ').filter((c) => !drop.includes(c.split('=')[0]));
  return Buffer.concat([pkt(Buffer.concat([line.subarray(0, z + 1), Buffer.from(caps.join(' ') + '\n')])), adv.subarray(n)]);
}
const ZERO = /^0{40}$|^0{64}$/;
const UPLOAD = '-c uploadpack.allowTipSHA1InWant=false -c uploadpack.allowReachableSHA1InWant=false -c uploadpack.allowAnySHA1InWant=false -c uploadpack.allowFilter=true';
const RECEIVE = '-c receive.fsckObjects=true -c receive.denyDeletes=true -c receive.advertisePushOptions=false';

const TOKEN_TTL_MS = 24 * 3600e3;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Per-agent git tokens (hashed): a principal on one instance, for every repo the instance exposes when used. */
const tokens = {
  init: (d: BetterSqlite3.Database) => d.exec('CREATE TABLE IF NOT EXISTS git_tokens (hash TEXT PRIMARY KEY, principal TEXT NOT NULL, instance_id TEXT NOT NULL, expires INTEGER NOT NULL)'),
  mint(principal: string, instanceId: string) {
    const t = `mcpgit_${randomBytes(24).toString('base64url')}`, expires = Date.now() + TOKEN_TTL_MS;
    db().prepare('DELETE FROM git_tokens WHERE expires<?').run(Date.now());
    db().prepare('INSERT INTO git_tokens(hash,principal,instance_id,expires) VALUES(?,?,?,?)').run(sha256(t), principal, instanceId, expires);
    return { token: t, expires };
  },
  /** `Authorization: Bearer <t>`, or Basic with the token as password (or user). */
  principal(auth: string | undefined, instanceId: string): string | undefined {
    let t = /^Bearer\s+(\S+)$/i.exec(auth ?? '')?.[1];
    const b = /^Basic\s+(\S+)$/i.exec(auth ?? '')?.[1];
    if (b) { const [u, ...pw] = Buffer.from(b, 'base64').toString().split(':'); t = pw.join(':') || u; }
    if (!t) return;
    const r = db().prepare('SELECT principal FROM git_tokens WHERE hash=? AND instance_id=? AND expires>?').get(sha256(t), instanceId, Date.now()) as { principal: string } | undefined;
    return r?.principal;
  },
};

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

const repoDefaults = { branchPrefix: 'agent/', baseBranches: [] as string[], askPaths: ['.github/', 'CODEOWNERS'], maxPatchKB: 1024, assistTrailer: 'Assisted-by' };

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

/** The ssh host `ssh -T git@…` checks the key against: the provider's (API URL's host, github.com), if any. */
const forgeSsh = (h: HostCfg) => {
  if (h.apiUrl) try { return new URL(h.apiUrl).hostname.replace(/^api\./, ''); } catch { return undefined; }
  return h.provider === 'github' || h.provider === 'gh' ? 'github.com' : h.provider === 'gitlab' ? 'gitlab.com' : undefined;
};
/** git present, repos dir and ssh key created if missing; the public key to add to the git server, and whether the forge accepts it. */
async function setupHost(run: Run, h: HostCfg, log: ScopedLogger) {
  const forge = forgeSsh(h);
  const ghStatus = h.provider === 'gh' ? `echo "gh=$(command -v gh >/dev/null && { GH_PROMPT_DISABLED=1 gh auth status 2>&1 | grep -Ei 'logged in|not logged|failed' | head -1; } || echo 'gh is not installed')"` : '';
  const out = await sh(run, h, `set -e
command -v git >/dev/null || { echo "git is not installed on this host" >&2; exit 2; }
echo "git=$(git --version)"
K=${qp(h.sshKey)}
mkdir -p "$(dirname "$K")" ${qp(h.reposDir)}
chmod 700 "$(dirname "$K")" 2>/dev/null || true
[ -f "$K" ] || { ssh-keygen -q -t ed25519 -N '' -C "mcontrolprogram-git@$(hostname)" -f "$K" && echo "created=1"; }
echo "pub=$(cat "$K.pub")"
${ghStatus}
${forge ? `echo "auth=$(ssh -i "$K" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -T ${q(`git@${forge}`)} 2>&1 | grep -Ei '^Hi |welcome|successfully authenticated|denied' | head -1 || true)"` : ''}
`, log);
  const kv = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const auth = !forge ? 'not checked: set a PR provider to test the key against it' : kv.auth || `no answer from ${forge} (blocked network?)`;
  return { git: kv.git, keyCreated: !!kv.created, publicKey: kv.pub, auth, keyAccepted: /^Hi |welcome|successfully authenticated/i.test(auth),
    ...(h.provider === 'gh' ? { gh: (kv.gh || 'no answer').trim(), ...(/logged in to/i.test(kv.gh ?? '') ? {} : { ghNext: 'Run `gh auth login` on the git host as the user MControlProgram runs git as (scopes: repo), then Set up host again.' }) } : {}) };
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

/** owner/repo (GitLab: group/…/repo) of the origin URL. */
export const slug = (r: Pick<RepoCfg, 'name' | 'url'>) => origin(r).path;

// ---- plugin -------------------------------------------------------------------------------------------------

const hostSchema = {
  type: 'object',
  required: ['name'],
  'x-kind-column': { title: 'Type', flags: { native: 'Native' }, default: 'SSH' },
  properties: {
    name: { type: 'string', title: 'Name', pattern: '^[a-zA-Z0-9_.-]+$', 'x-pattern-hint': 'letters, digits, _ . -' },
    native: { type: 'boolean', title: 'Native (this machine)', default: false, description: 'Run git on the machine MControlProgram runs on (inside its container if it is containerised), without ssh. Paths and ~ are the MControlProgram user\'s.' },
    sshHost: { type: 'string', title: 'SSH host', description: 'Host from the SSH plugin inventory (pinned host key) with git installed. Commands run as that user. Not used for native hosts.', 'x-options-from': 'ssh:hosts' },
    reposDir: { type: 'string', title: 'Repos directory', description: 'Clones directly under it are picked up as repos. ~/ = the host user\'s home. Native host in a container: use a path on the data volume (e.g. /data/git/repos, and SSH key /data/git/id_ed25519) so clones and key survive rebuilds.', default: '~/mcontrolprogram-repos' },
    provider: { type: 'string', title: 'PR provider', enum: [...PROVIDERS], default: 'none', description: 'Forge behind these repos, for create_pr / pr / comment. none = git only: any git server. gh = GitHub through the gh CLI on the git host, using its `gh auth login` (no token here). The others use the API token below.' },
    description: { type: 'string', title: 'Description', 'x-no-column': true },
    sshKey: { type: 'string', title: 'SSH key', description: 'Private key on the host for pushing over ssh; "Set up host" creates it. Add its public key to the git server: a deploy key with write access (one repo) or a machine user\'s key.', default: '~/.ssh/mcontrolprogram_git', 'x-no-column': true },
    committerName: { type: 'string', title: 'Committer name', default: 'MControlProgram', 'x-no-column': true },
    committerEmail: { type: 'string', title: 'Committer email', default: 'mcontrolprogram@noreply.invalid', 'x-no-column': true },
    token: { type: 'string', title: 'API token', 'x-secret': true, 'x-no-column': true, description: 'For the PR provider\'s REST API. GitHub: fine-grained token with Pull requests read & write. GitLab: api scope. Gitea / Forgejo: repository read & write. Kept by MControlProgram, never sent to the host or agents.' },
    apiUrl: { type: 'string', title: 'API URL', 'x-no-column': true, description: 'Empty = from the origin\'s host: https://api.github.com (other hosts: https://host/api/v3), GitLab https://host/api/v4, Gitea / Forgejo https://host/api/v1' },
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
    assistTrailer: { type: 'string', title: 'Assisted-by trailer', default: 'Assisted-by', pattern: '^([A-Za-z][A-Za-z0-9-]*)?$', 'x-pattern-hint': 'a trailer name like Assisted-by, or empty for none', 'x-no-column': true,
      description: 'Trailer naming the agent on commits made through submit_patch (e.g. Assisted-by: Claude Code). Empty = none. Commits are authored and committed by the git host\'s identity.' },
  },
};

const plugin: MControlProgramPlugin = {
  id: 'git',
  name: 'Git',
  version: '0.4.0',
  navOrder: 35,
  dependencies: { mcp: '^0.2.0', ssh: '^0.2.3' },
  description: 'Agents with a read-only clone fetch from and push to MControlProgram (or submit patches); it commits and pushes from clones on a git host (SSH or this machine) to any git server, and opens PRs on GitHub, GitLab or Gitea / Forgejo. Every tool and git feature is allow / ask / deny per repo.',
  init(h) {
    // was the `github` plugin: its tables become ours (core moved its config, instances and approvals)
    for (const t of ['calls', 'rules', 'tools', 'policy', 'git_tokens']) {
      const has = (n: string) => !!h.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
      const to = t === 'git_tokens' ? 'git_tokens' : `git_${t}`;
      if (has(`github_${t}`) && !has(to)) h.db.exec(`ALTER TABLE github_${t} RENAME TO ${to}`);
    }
    rules = h.dep<McpApi>('mcp').toolRuleStore(() => h.db, 'git', { defaultPolicy: 'readonly' }); db = () => h.db; tokens.init(h.db);
  },
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
        return { ...setup, ...(await scan(run, a, h.name)), next: setup.keyAccepted ? undefined : 'Add publicKey to the git server: a deploy key with write access (GitHub: repo Settings → Deploy keys) or an SSH key of a machine user, then run Set up host again.' };
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
    const run = runner(ctx.dep<SshApi>('ssh')), spawnOn = spawner(ctx.dep<SshApi>('ssh'));
    const prefix = ctx.instanceName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const gitUrl = (r: Repo) => `${(ctx.serverUrl?.() ?? '').replace(/\/$/, '')}/plugins/${prefix}/git/${r.name}.git`;
    /** Script start in the host clone, with S = its bare mirror for agents and W = the clone. */
    const inServe = (r: Repo) => `${prelude(r.h)}cd ${qp(r.path)}\nW=$(pwd); S=$(sv)\n`;
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
          allowedBy = await rules.gate(call, entry, RO[name], { feature: 'git_tool', summary: `${r.name}: ${summary}`, subject: { upstream: r.name, tool: name, features, ...subject } },
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

    /** Branches agents may push to directly with base_push: the repo's base branches, else origin's default branch. */
    const baseOf = async (r: Repo, log: ScopedLogger): Promise<string[]> => {
      if (r.baseBranches.length) return r.baseBranches;
      const d = (await sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}\ng symbolic-ref -q --short refs/remotes/origin/HEAD || { g remote set-head origin -a >/dev/null 2>&1 && g symbolic-ref -q --short refs/remotes/origin/HEAD; } || true`, log)).trim().replace(/^origin\//, '');
      return d ? [d] : [];
    };
    const prov = (r: Repo, call: ToolCallContext) => provider(r.h, r, call.signal, (script, input) => run(r.h, script, call.log, input));
    const checkBase = (r: Repo, base?: string) => { if (base && r.baseBranches.length && !r.baseBranches.includes(base)) throw new Error(`base must be one of: ${r.baseBranches.join(', ')}`); };
    const names = z.array(z.string()).optional();
    /** `b` if it is an agent branch (never a base branch, even with an empty prefix). */
    const deletable = async (r: Repo, b: string, log: ScopedLogger) => {
      if (!b.startsWith(r.branchPrefix) || agentBranch(r, b) !== b || (await baseOf(r, log)).includes(b)) throw new Error(`"${b}" is not an agent branch; only those can be deleted here`);
      return b;
    };
    const deleteBranch = (r: Repo, branch: string, log: ScopedLogger) => locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}
g push -q --no-verify origin --delete ${q(branch)}
g update-ref -d ${q(`refs/remotes/origin/${branch}`)} || true`, log));

    const tools: ToolDefinition[] = [
      {
        name: 'repos', description: 'Repos you can work on through MControlProgram: origin URL to clone read-only, agent branch prefix, base branches (PR targets; pushing straight to one needs approval) and sensitive paths.',
        inputSchema: {}, annotations: { readOnlyHint: true },
        // base branches: configured, else origin's default branch (what PRs target and base_push may push to)
        handler: async () => text(JSON.stringify(await Promise.all(exposed.map(async (r) => ({ name: r.name, origin: r.url, description: r.description, branchPrefix: r.branchPrefix,
          baseBranches: await baseOf(r, ctx.log).catch(() => r.baseBranches), sensitivePaths: r.askPaths }))), null, 2)),
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
      tool('clone_url', `A git remote on MControlProgram for the repo, with a token for you (valid 24h). It has origin's branches and tags, so after \`git fetch mcp\`, \`git log mcp/<base>..HEAD\` and \`git diff mcp/<base>\` show exactly what you have that MControlProgram doesn't. \`git push mcp HEAD:<branch prefix><name>\` sends your commits as they are (commit as the identity it returns, with an Assisted-by trailer); MControlProgram forwards them to that branch on GitHub (if the push says it awaits approval, run the same push again later). On 403 "expired git token", call this again and run \`refresh\`.`,
        {},
        async (r, _a, call, gate) => {
          await gate(['clone_url'], 'git remote URL and token', {});
          const url = gitUrl(r);
          const { token, expires } = tokens.mint(call.principal ?? 'anonymous', ctx.instanceId);
          const key = `http.${url}.extraHeader`, val = `Authorization: Bearer ${token}`;
          return {
            url, expires: new Date(expires).toISOString(), branchPrefix: r.branchPrefix,
            // commits under the host's identity push without custom_identity; the trailer names the agent
            addRemote: `git remote add mcp ${q(url)} && git config ${q(key)} ${q(val)} && git config user.name ${q(r.h.committerName)} && git config user.email ${q(r.h.committerEmail)}`,
            refresh: `git config ${q(key)} ${q(val)}`,
            clone: `git clone -o mcp -c ${q(`${key}=${val}`)} -c ${q(`user.name=${r.h.committerName}`)} -c ${q(`user.email=${r.h.committerEmail}`)} ${q(url)}`,
            then: ['git fetch mcp', 'git log --oneline mcp/<base>..HEAD  # your commits MControlProgram lacks',
              ...(r.assistTrailer ? [`git commit --trailer ${q(`${r.assistTrailer}: <you, e.g. Claude Code (model)>`)} …`] : []), `git push mcp HEAD:${r.branchPrefix}<name>`],
            identity: `${r.h.committerName} <${r.h.committerEmail}>: commit as this (the setup commands configure it); other authors or committers need approval`,
            ...(/\/\/(localhost|127\.)/.test(url) ? { note: "This URL is the server's default; if you can't reach it, ask the admin to set the server's Public URL." } : {}),
          };
        }),
      tool('submit_patch', 'Apply your change on `base` (the commit you started from, see resolve), commit it and push it to an agent branch, or to a base branch when \`branch\` names one exactly (see repos; needs approval, never rewritten). `patch` is `git format-patch --stdout <base>` output (keeps your commits and messages; preferred) or a plain `git diff` plus `message`. Pushing over a branch you pushed before needs it to fast-forward, else `force: true`. Commits are authored and committed by the git identity of MControlProgram, with an Assisted-by trailer naming you (`assisted_by`), so they get new shas: returns the pushed sha, `git fetch origin <branch>` to sync. Binary files need `format-patch --binary`.',
        {
          base: z.string().describe('Commit sha (or branch/tag) the patch was made on'),
          patch: z.string().describe('git format-patch --stdout output, or a unified git diff'),
          branch: z.string().describe('Agent branch to push to (the repo prefix is added if missing), or a base branch by its exact name'),
          message: z.string().optional().describe('Commit message, required for a plain diff'),
          force: z.boolean().optional().describe('Allow rewriting the branch (not a fast-forward)'),
          assisted_by: z.string().optional().describe('Who made the change, for the Assisted-by trailer, e.g. "Claude Code (claude-opus-5-5)". Default: your MCP client name and version.'),
          committer_name: z.string().optional().describe("Author and committer name (with committer_email) instead of MControlProgram's git identity"),
          committer_email: z.string().optional().describe('Committer email, with committer_name'),
        },
        async (r, a, call, gate) => {
          if (Buffer.byteLength(a.patch) > r.maxPatchKB * 1024) throw new Error(`patch is over ${r.maxPatchKB} KB`);
          const toBase = (await baseOf(r, call.log)).includes(a.branch);
          const branch = toBase ? a.branch : agentBranch(r, a.branch);
          const ident = identity(a.committer_name, a.committer_email);
          const assisted = assistTrailer(r.assistTrailer, a.assisted_by, call.client);
          const x = await apply(run, r, { base: a.base, patch: a.patch, branch, message: a.message, principal: call.principal, ident, assisted }, call.log);
          if (toBase && x.force) throw new Error(`${branch} is a base branch and is never rewritten: your commits don't build on its current ${x.previous}. Rebase onto it (resolve ${branch}) and submit again.`);
          if (x.force && !a.force) throw new Error(`${branch} is at ${x.previous}, which your commits don't build on. Rebase onto it (resolve ${branch}), or pass force: true to replace it.`);
          const sensitive = x.files.filter((f) => r.askPaths.some((p) => globMatch(p, f)));
          const features = ['submit_patch', ...(toBase ? ['base_push'] : []), ...(x.force ? ['force_push'] : []), ...(ident ? ['custom_identity'] : []), ...(sensitive.length ? ['sensitive_paths'] : [])];
          const what = `${x.force ? 'force-push' : 'push'} ${x.commits} commit(s) to ${branch}: ${x.files.length} file(s)${ident ? `, as ${ident.name} <${ident.email}>` : ''}${sensitive.length ? `, sensitive: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}` : ''}`;
          const by = await gate(features, what, { branch, base: x.base, patch: createHash('sha256').update(a.patch).digest('hex').slice(0, 16), force: x.force, ident, assisted });
          await push(run, r, x, branch, call.log);
          ctx.log.info(`${r.name}: ${what} (${x.sha.slice(0, 12)}) for ${call.principal ?? 'agent'}, ${by}`);
          return { branch, sha: x.sha, base: x.base, commits: x.commits, files: x.files, forced: x.force, sync: `git fetch origin ${branch} && git checkout ${x.sha}` };
        }),
      tool('delete_branch', 'Delete an agent branch on the remote (e.g. after its PR merged). Only branches with the repo prefix.',
        { branch: z.string() },
        async (r, a, call, gate) => {
          if ((await baseOf(r, call.log)).includes(a.branch)) throw new Error(`"${a.branch}" is a base branch; only agent branches can be deleted`);
          const branch = await deletable(r, agentBranch(r, a.branch), call.log);
          await gate(['delete_branch'], `delete ${branch}`, { branch });
          await deleteBranch(r, branch, call.log);
          return { deleted: branch };
        }),
      tool('git', `Run git in MControlProgram's own clone of the repo (on the git host, shared by every agent on it): pull / fetch from origin, switch branches, merge, rebase, cherry-pick, stash, reset, add / rm, commit, and status / log / diff / show to look around. Returns git's output and exit code; a conflict exits non-zero and lists the files: read the sides with \`show :1:<path>\` (base) \`:2:\` (ours) \`:3:\` (theirs), write the result with write_file, then commit or \`rebase --continue\` (or \`merge --abort\`). Editors are off: give messages with --message=. Commits are by MControlProgram's git identity. Push the result with push. Allowed: ${[...WT_READ, ...WT_WRITE].join(', ')}.`,
        { command: z.string().describe('git subcommand, e.g. "pull"'), args: z.array(z.string()).optional().describe('Its arguments, one per item, e.g. ["--rebase", "origin", "main"]') },
        async (r, a, call, gate) => {
          const args: string[] = a.args ?? [];
          workdirCheck(a.command, args);
          const write = WT_WRITE.includes(a.command);
          await gate([write ? 'workdir' : 'workdir_read'], `git ${[a.command, ...args].join(' ')}`.slice(0, 300), { command: a.command, args });
          const out = await locked(r, () => run(r.h, `${prelude(r.h)}cd ${qp(r.path)}
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no GIT_PAGER=cat PAGER=cat
set +e
g -c color.ui=never ${[a.command, ...args].map(q).join(' ')} 2>&1
c=$?
${write ? 'sync >/dev/null 2>&1' : ''}
exit $c`, call.log));
          const o = out.stdout + out.stderr;
          // ponytail: 100 KB of output; page with log -n / diff -- <path> beyond that
          return `${o.length > 100_000 ? `${o.slice(0, 100_000)}\n… (truncated)` : o}${o.endsWith('\n') || !o ? '' : '\n'}exit ${out.code}`;
        }),
      tool('write_file', "Write a file in MControlProgram's clone and stage it (git add): how you resolve a conflict from the git tool. Then commit, `rebase --continue`, `cherry-pick --continue`… with git.",
        { path: z.string().describe('Path in the repo'), content: z.string().describe('The whole file') },
        async (r, a, call, gate) => {
          if (Buffer.byteLength(a.content) > r.maxPatchKB * 1024) throw new Error(`file is over ${r.maxPatchKB} KB`);
          if (!a.path || a.path.startsWith('/') || a.path.split('/').some((c: string) => c === '..' || c === '')) throw new Error(`invalid path "${a.path}"`);
          await gate(['workdir'], `write ${a.path} (${Buffer.byteLength(a.content)} bytes)`, { path: a.path, content: createHash('sha256').update(a.content).digest('hex').slice(0, 16) });
          // through the index: git refuses paths in .git and replaces symlinks on the way, so nothing lands outside the clone
          return locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}
p=${q(a.path)}; m=100644
[ -f "$p" ] && [ ! -L "$p" ] && [ -x "$p" ] && m=100755
b=$(g hash-object -w --stdin)
g update-index --add --cacheinfo "$m,$b,$p"
g checkout-index -f -- "$p"
GIT_LITERAL_PATHSPECS=1 g status --short -- "$p"`, call.log, a.content));
        }),
      tool('push', "Push a branch prepared in MControlProgram's clone (with the git tool) to an agent branch on origin, or to a base branch by its exact name (see repos; needs approval, never rewritten). Commits are pushed as they are; authors or committers other than MControlProgram's git identity need approval. Rewriting a branch needs `force: true`.",
        {
          branch: z.string().describe('Agent branch to push to (the repo prefix is added if missing), or a base branch by its exact name'),
          source: z.string().optional().describe('Local branch or commit in the clone; default HEAD'),
          force: z.boolean().optional().describe('Allow rewriting the branch (not a fast-forward)'),
        },
        async (r, a, call, gate) => {
          const toBase = (await baseOf(r, call.log)).includes(a.branch);
          const branch = toBase ? a.branch : agentBranch(r, a.branch);
          const out = await locked(r, () => sh(run, r.h, `${prelude(r.h)}cd ${qp(r.path)}
fetch
new=$(g rev-parse -q --verify ${q(`${ref(a.source ?? 'HEAD')}^{commit}`)}) || { echo ${q(`"${a.source ?? 'HEAD'}" is not a commit in the clone`)} >&2; exit 2; }
prev=$(g rev-parse -q --verify ${q(`refs/remotes/origin/${branch}`)} || true)
echo "sha=$new"; echo "prev=$prev"
${inspect('refs/remotes/origin/HEAD')}`, call.log));
          const { kv, force, files, sensitive, others } = inspected(out, r);
          if (kv.sha === kv.prev) return { branch, sha: kv.sha, unchanged: true };
          if (toBase && force) throw new Error(`${branch} is a base branch and is never rewritten: rebase onto origin/${branch} (git pull --rebase origin ${branch}) and push again.`);
          if (force && !a.force) throw new Error(`${branch} is at ${kv.prev}, which ${a.source ?? 'HEAD'} doesn't build on. Rebase onto it, or pass force: true to replace it.`);
          const features = ['push', ...(toBase ? ['base_push'] : []), ...(force ? ['force_push'] : []), ...(others.length ? ['custom_identity'] : []), ...(sensitive.length ? ['sensitive_paths'] : [])];
          const what = `${force ? 'force-push' : 'push'} ${kv.commits} commit(s) from the clone to ${branch}: ${files.length} file(s)${others.length ? `, as ${others.slice(0, 3).join(', ')}` : ''}${sensitive.length ? `, sensitive: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}` : ''}`;
          const by = await gate(features, what, { branch, sha: kv.sha, force });
          await push(run, r, { sha: kv.sha, previous: kv.prev || undefined }, branch, call.log);
          ctx.log.info(`${r.name}: ${what} (${kv.sha.slice(0, 12)}) for ${call.principal ?? 'agent'}, ${by}`);
          return { branch, sha: kv.sha, commits: Number(kv.commits), files, forced: force };
        }),
      ...(exposed.some((r) => r.h.provider !== 'none') ? [
        tool('create_pr', 'Open a pull request (GitLab: merge request) from an agent branch (push it first). If one is already open for the branch, returns it unchanged. `labels`, `assignees` and `reviewers` are added to a PR this call opens (as edit_pr would).',
          {
            branch: z.string().describe('Agent branch (head)'),
            base: z.string().optional().describe('Target branch; default: the first base branch, else the default branch'),
            title: z.string(), body: z.string().optional(), draft: z.boolean().optional(),
            labels: names, assignees: names, reviewers: names,
          },
          async (r, a, call, gate) => {
            const head = agentBranch(r, a.branch);
            checkBase(r, a.base);
            const p = prov(r, call);
            const extras = !!(a.labels?.length || a.assignees?.length || a.reviewers?.length);
            await gate(['create_pr', ...(extras ? ['edit_pr'] : [])], `PR ${head} → ${a.base ?? r.baseBranches[0] ?? 'default branch'}: ${a.title}${extras ? ` (+ ${[a.labels?.length && 'labels', a.assignees?.length && 'assignees', a.reviewers?.length && 'reviewers'].filter(Boolean).join(', ')})` : ''}`,
              { head, base: a.base, title: a.title, labels: a.labels, assignees: a.assignees, reviewers: a.reviewers });
            const pr = await p.create({ head, base: a.base ?? r.baseBranches[0] ?? await p.defaultBranch(), title: a.title, body: a.body ?? '', draft: !!a.draft });
            if (pr.existing || !extras) return pr;
            // the PR is open now: if the extras fail, say so rather than hide the PR
            try {
              const d = await p.edit(pr.number, { labels: a.labels?.length ? { add: a.labels } : undefined, assignees: a.assignees?.length ? { add: a.assignees } : undefined, reviewers: a.reviewers?.length ? { add: a.reviewers } : undefined });
              return { ...pr, labels: d.labels, assignees: d.assignees, reviewers_requested: d.reviewers_requested };
            } catch (e) { return { ...pr, warning: `PR opened, but labels / assignees / reviewers were not all applied: ${(e as Error).message}. Use edit_pr.` }; }
          }),
        tool('pr', 'Without `number`: list pull requests (GitLab: merge requests), the latest 50 in the state; `search` keeps those matching it. With `number`: the PR with its checks, reviews and comments.',
          {
            number: z.number().int().optional(), state: z.enum(['open', 'closed', 'all']).optional().describe('For the list; default open'),
            search: z.string().optional().describe('For the list: words that must all appear in the PR title, branch or author (case-insensitive), e.g. a ticket id'),
          },
          async (r, a, call, gate) => {
            const p = prov(r, call);
            await gate(['pr'], a.number ? `read PR #${a.number}` : 'list PRs', { number: a.number });
            if (a.number) return p.get(a.number);
            const words: string[] = (a.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            return (await p.list(a.state ?? 'open')).filter((x) => { const hay = `${x.title} ${x.head} ${x.user ?? ''}`.toLowerCase(); return words.every((w: string) => hay.includes(w)); });
          }),
        tool('comment', 'Comment on a pull request (GitHub, Gitea: or an issue; GitLab: a merge request).', { number: z.number().int(), body: z.string() },
          async (r, a, call, gate) => {
            const p = prov(r, call);
            await gate(['comment'], `comment on #${a.number}`, { number: a.number, body: a.body });
            return p.comment(a.number, a.body);
          }),
        tool('merge_pr', 'Merge a pull request (GitLab: merge request). Pass `sha` (the head you checked, see pr) so it only merges that. GitLab: no rebase method (the project picks merge commit or fast-forward).',
          {
            number: z.number().int(), method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Default merge'),
            sha: z.string().optional().describe('Merge only if the head is still this commit'),
            title: z.string().optional().describe('Merge / squash commit title'), message: z.string().optional().describe('Merge / squash commit message'),
            delete_branch: z.boolean().optional().describe('Then delete the head branch (agent branches only)'),
          },
          async (r, a, call, gate) => {
            const p = prov(r, call);
            const head = a.delete_branch ? await deletable(r, (await p.get(a.number)).head, call.log) : undefined;
            await gate(['merge_pr', ...(head ? ['delete_branch'] : [])], `merge #${a.number}${a.method ? ` (${a.method})` : ''}${a.sha ? ` at ${a.sha.slice(0, 12)}` : ''}${head ? `, delete ${head}` : ''}`,
              { number: a.number, method: a.method, sha: a.sha, delete: head });
            const m = await p.merge(a.number, a);
            if (head && m.merged) await deleteBranch(r, head, call.log);
            return { ...m, ...(head && m.merged ? { deleted: head } : {}) };
          }),
        tool('edit_pr', 'Edit a pull request: title, body, base, close / reopen, draft / ready for review, and add or remove labels, assignees and requested reviewers (usernames). Returns the PR as `pr` does.',
          {
            number: z.number().int(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional().describe('New target branch'),
            state: z.enum(['open', 'closed']).optional(), draft: z.boolean().optional(),
            add_labels: names, remove_labels: names, add_assignees: names, remove_assignees: names, add_reviewers: names, remove_reviewers: names,
          },
          async (r, a, call, gate) => {
            checkBase(r, a.base);
            const d = (add?: string[], remove?: string[]) => (add?.length || remove?.length ? { add, remove } : undefined);
            const e = { title: a.title, body: a.body, base: a.base, state: a.state, draft: a.draft,
              labels: d(a.add_labels, a.remove_labels), assignees: d(a.add_assignees, a.remove_assignees), reviewers: d(a.add_reviewers, a.remove_reviewers) };
            const changed = Object.entries(e).filter(([, v]) => v !== undefined).map(([k]) => k);
            if (!changed.length) throw new Error('nothing to change');
            const p = prov(r, call);
            await gate(['edit_pr'], `edit #${a.number}: ${changed.join(', ')}${a.state ? ` (${a.state === 'closed' ? 'close' : 'reopen'})` : ''}`, { number: a.number, ...e });
            return p.edit(a.number, e);
          }),
        tool('review_pr', 'Review a pull request: approve, request changes or comment (the last two need `body`). Forges refuse approving a PR opened with the same account. GitLab: approve and comment only.',
          { number: z.number().int(), event: z.enum(['approve', 'request_changes', 'comment']), body: z.string().optional() },
          async (r, a, call, gate) => {
            if (a.event !== 'approve' && !a.body) throw new Error(`${a.event} needs a body`);
            const p = prov(r, call);
            await gate(['review_pr'], `${a.event.replace('_', ' ')} #${a.number}`, { number: a.number, event: a.event, body: a.body });
            return p.review(a.number, a);
          }),
      ] : []),
    ];

    /** One pushed ref, already in the mirror: check it like submit_patch, ask, then push it to origin. */
    async function forward(r: Repo, c: { old: string; nu: string; ref: string }, call: Pick<ToolCallContext, 'ask'>, entry: LogEntry, base: boolean) {
      const branch = c.ref.slice('refs/heads/'.length), prev = ZERO.test(c.old) ? '' : c.old;
      const t0 = Date.now();
      let allowedBy: string | undefined;
      try {
        const out = await locked(r, () => sh(run, r.h, `${inServe(r)}cd "$S"
new=${q(c.nu)}; prev=${q(prev)}
${inspect('HEAD')}`, ctx.log));
        // commits are expected under the host's identity (clone_url sets it up); anyone else is custom_identity
        const { kv, force, files, sensitive, others } = inspected(out, r);
        if (base && force) throw new Error(`${branch} is a base branch and is never rewritten: fetch, rebase onto mcp/${branch} and push again`);
        const features = ['git_push', ...(base ? ['base_push'] : []), ...(force ? ['force_push'] : []), ...(others.length ? ['custom_identity'] : []), ...(sensitive.length ? ['sensitive_paths'] : [])];
        const what = `git push: ${force ? 'force-push' : 'push'} ${kv.commits} commit(s) to ${branch}: ${files.length} file(s)${others.length ? `, as ${others.slice(0, 3).join(', ')}` : ''}${sensitive.length ? `, sensitive: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}` : ''}`;
        try {
          allowedBy = await rules.gate(call, entry, false, { feature: 'git_tool', summary: `${r.name}: ${what}`, subject: { upstream: r.name, tool: 'git_push', features, branch, sha: c.nu, force } },
            features.map((f) => ({ tool: f, readOnly: RO[f] })));
        } catch (e) { (e as any).gated = true; throw e; }
        await locked(r, () => sh(run, r.h, `${inServe(r)}url=$(g remote get-url origin)
g -C "$S" push -q --no-verify ${q(`--force-with-lease=refs/heads/${branch}:${prev}`)} "$url" ${q(`${c.nu}:refs/heads/${branch}`)}
g -C "$S" push -q --no-verify "$W" ${q(`+${c.nu}:refs/remotes/origin/${branch}`)}
`, ctx.log));
        rules.record({ ...entry, args: { branch, sha: c.nu }, allowedBy, ms: Date.now() - t0 });
        ctx.log.info(`${r.name}: ${what} (${c.nu.slice(0, 12)}) for ${entry.principal}, ${allowedBy}`);
      } catch (e) {
        if (!(e as any).gated) try { rules.record({ ...entry, args: { branch, sha: c.nu }, allowedBy, ms: Date.now() - t0, error: String((e as Error).message).slice(0, 500) }); } catch { /* logged below */ }
        throw e;
      }
    }

    /** git smart HTTP at `/git/<repo>.git`: fetch from the mirror, pushes forwarded ref by ref. */
    async function http(req: IncomingMessage, res: ServerResponse, hc: HttpContext) {
      const fail = (code: number, msg: string) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${msg}\n`); };
      const m = /^\/git\/([^/?]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)(?:\?(.*))?$/.exec(req.url ?? '');
      if (!m) return fail(404, 'not found');
      const svc = m[2] === 'info/refs' ? new URLSearchParams(m[3] ?? '').get('service') : m[2];
      if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') return fail(403, 'MControlProgram speaks git smart HTTP only');
      if ((m[2] === 'info/refs') !== (req.method === 'GET')) return fail(405, 'method not allowed');
      const principal = tokens.principal(req.headers.authorization, ctx.instanceId);
      if (!principal) return fail(403, `missing or expired MControlProgram git token: call ${prefix}_clone_url and run its refresh command`);
      const r = exposed.find((x) => x.name === m[1]);
      if (!r) return fail(404, `no repo "${m[1]}" on this server`);
      const push = svc === 'git-receive-pack', tool = push ? 'git_push' : 'clone_url';
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const call = { ask: (spec: Parameters<HttpContext['ask']>[2]) => hc.ask(principal, `${prefix}_${tool}`, spec, abort.signal) };
      const entry: LogEntry = { serverId: ctx.serverId, instance: ctx.instanceName, principal, upstream: r.name, tool, args: {} };
      try {
        if (m[2] === 'info/refs') {
          if (push) { if (rules.verdict(r.name, 'git_push', false).action === 'deny') throw new Error(`${r.name}/git_push is disabled by the administrator. Tell the user if you need it.`); }
          else await rules.gate(call, entry, true, { feature: 'git_tool', summary: `${r.name}: git fetch`, subject: { upstream: r.name, tool, features: [tool] } });
          // ponytail: fetches origin on every advertisement (~1s); cache for a few seconds if agents fetch in loops
          const out = await locked(r, async () => collect(await spawnOn(r.h, `${inServe(r)}[ -d "$S" ] || g init -q --bare "$S"
fetch || true
cd "$S"
g ${push ? RECEIVE : UPLOAD} ${svc.slice(4)} --stateless-rpc --advertise-refs .`, ctx.log)));
          if (out.code !== 0) throw new Error(out.err.trim() || `exit ${out.code}`);
          res.writeHead(200, { 'Content-Type': `application/x-${svc}-advertisement`, 'Cache-Control': 'no-cache' });
          res.end(Buffer.concat([pkt(`# service=${svc}\n`), Buffer.from('0000'), push ? stripCaps(out.out, ['report-status-v2', 'side-band', 'side-band-64k', 'atomic', 'push-options', 'push-cert']) : out.out]));
          return;
        }
        if (!push) {
          if (rules.verdict(r.name, tool, true).action === 'deny') throw new Error(`${r.name}/${tool} is disabled by the administrator.`);
          const p = await spawnOn(r.h, `${inServe(r)}cd "$S"\ng ${UPLOAD} upload-pack --stateless-rpc .`, ctx.log);
          let err = '';
          p.stderr.on('data', (d: Buffer) => (err += d));
          p.stdin.on('error', () => {});
          res.on('close', () => { if (!res.writableFinished) p.kill(); });
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
          const body = req.headers['content-encoding'] === 'gzip' ? req.pipe(zlib.createGunzip()).on('error', () => p.kill()) : req;
          body.pipe(p.stdin);
          p.stdout.pipe(res);
          const code = await p.done;
          if (code) ctx.log.warn(`${r.name}: upload-pack for ${principal} exited ${code}: ${err.trim().slice(0, 300)}`);
          return;
        }
        // push: read it all (bounded), check the ref updates, let receive-pack store it in the mirror, forward each ref
        const max = r.maxPatchKB * 1024, chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) { n += c.length; if (n > max) return fail(413, `push is over ${r.maxPatchKB} KB (the repo's max patch size)`); chunks.push(c as Buffer); }
        const body = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(Buffer.concat(chunks), { maxOutputLength: max }) : Buffer.concat(chunks);
        const cmds = readPkts(body).lines.map((l) => l.toString('latin1').replace(/\n$/, '').split('\0')[0]).filter((l) => !l.startsWith('shallow '))
          .map((l) => { const [old = '', nu = '', ref = ''] = l.split(' '); return { old, nu, ref }; });
        const why = (c: (typeof cmds)[number]) => {
          if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c.old) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c.nu)) return 'malformed update';
          if (!c.ref.startsWith('refs/heads/')) return 'only branches can be pushed';
          if (ZERO.test(c.nu)) return `delete agent branches with ${prefix}_delete_branch`;
          const b = c.ref.slice('refs/heads/'.length);
          if (bases.includes(b)) return '';
          try { const a = agentBranch(r, b); return a === b ? '' : `push to an agent branch: git push mcp HEAD:${a}${bases.length ? ` (or to a base branch, with approval: ${bases.join(', ')})` : ''}`; } catch (e) { return (e as Error).message; }
        };
        const report: string[] = [];
        if (!cmds.length) throw new Error('empty push');
        const bases = await baseOf(r, ctx.log);
        if (cmds.some(why)) report.push('unpack ok', ...cmds.map((c) => `ng ${c.ref} ${why(c) || 'not pushed: another ref in this push was refused'}`));
        else {
          const rp = await locked(r, async () => collect(await spawnOn(r.h, `${inServe(r)}cd "$S"\ng ${RECEIVE} receive-pack --stateless-rpc .`, ctx.log), body));
          const status = readPkts(rp.out).lines.map((l) => l.toString().replace(/\n$/, ''));
          if (!status[0]?.startsWith('unpack ')) throw new Error(rp.err.trim() || `receive-pack exited ${rp.code}`);
          report.push(status[0]);
          for (const c of cmds) {
            const st = status.find((l) => l === `ok ${c.ref}` || l.startsWith(`ng ${c.ref} `));
            if (!st?.startsWith('ok ')) { report.push(st ?? `ng ${c.ref} not received`); continue; }
            try { await forward(r, c, call, entry, bases.includes(c.ref.slice('refs/heads/'.length))); report.push(`ok ${c.ref}`); }
            catch (e) {
              const msg = String((e as Error).message).replace(/\s+/g, ' ').slice(0, 1000);
              report.push(`ng ${c.ref} ${(e as any).status === 'pending' ? `${msg} Run the same git push again to check back.` : msg}`);
            }
          }
          // refused or failed refs go back to origin's value
          await locked(r, () => sh(run, r.h, `${inServe(r)}sync`, ctx.log)).catch((e) => ctx.log.warn(`${r.name}: mirror sync: ${(e as Error).message}`));
        }
        res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' });
        res.end(Buffer.concat([...report.map((l) => pkt(`${l}\n`)), Buffer.from('0000')]));
      } catch (e) {
        ctx.log.warn(`${r.name}: git ${push ? 'push' : 'fetch'} by ${principal}: ${(e as Error).message}`);
        fail(403, (e as Error).message);
      }
    }

    return {
      tools,
      http,
      instructions: 'Git via MControlProgram: {prefix}_clone_url gives you a git remote ("mcp") with what MControlProgram has: `git fetch mcp`, compare with `git log mcp/<base>..HEAD`, and `git push mcp HEAD:<branch prefix><name>` to have your commits pushed to GitHub. Without network access to it: {prefix}_resolve gives the sha to work on, and {prefix}_submit_patch takes `git format-patch --stdout <base>`. Then open a PR with {prefix}_create_pr; {prefix}_pr shows its checks and reviews, {prefix}_review_pr / {prefix}_edit_pr / {prefix}_merge_pr (with delete_branch) finish it, all through MControlProgram (merge with merge_pr rather than merging locally). Pushing straight to a base branch ({prefix}_repos lists them) works too, by its exact name (git push mcp HEAD:main, or submit_patch with branch "main"), but needs approval and must fast-forward; if a push or call says it awaits approval, repeat it later. You can also work in MControlProgram\'s own clone: {prefix}_git (pull, switch, merge / rebase, stash, commit, status / diff …), {prefix}_write_file to resolve conflicts, {prefix}_push to send the result to a branch.',
      status: () => ({ repos: exposed.map((r) => ({ name: r.name, host: r.host, origin: r.url })) }),
    };
  },
};

const hostOf = (g: GlobalCfg, name: unknown) => { const h = g.hosts.find((x) => x.name === name); if (!h) throw new Error(`unknown git host "${String(name)}"`); return h; };
/** Config with defaults filled in (fields added later, or left empty in the form). */
function withDefaults(c: Record<string, any>): GlobalCfg {
  return {
    hosts: (c.hosts ?? []).map((h: HostCfg) => ({ ...h, provider: h.provider ?? (h.token ? 'github' : 'none'), reposDir: h.reposDir || '~/mcontrolprogram-repos', sshKey: h.sshKey || '~/.ssh/mcontrolprogram_git', committerName: h.committerName || 'MControlProgram', committerEmail: h.committerEmail || 'mcontrolprogram@noreply.invalid' })),
    repos: (c.repos ?? []).map((r: RepoCfg) => ({ ...repoDefaults, ...r, branchPrefix: r.branchPrefix ?? 'agent/', maxPatchKB: r.maxPatchKB || 1024 })),
  };
}
export default plugin;
