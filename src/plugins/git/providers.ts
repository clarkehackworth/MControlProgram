/**
 * PR providers: the REST calls behind create_pr / pr / comment, per git host. Each returns the same shapes, so the
 * tools and agents don't care which forge is behind a repo. The token stays here: never on the git host or agents.
 */
/** `gh` = GitHub through the `gh` CLI on the git host, with its own login (`gh auth login` there): no token in MControlProgram. */
export const PROVIDERS = ['none', 'github', 'gh', 'gitlab', 'gitea'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface Pr { number: number; title: string; state: 'open' | 'closed' | 'merged'; draft?: boolean; head: string; base: string; url: string; user?: string; updated?: string }
export interface PrDetail extends Pr {
  headSha: string; mergeable?: boolean | null; body?: string;
  checks: { name: string; status: string; conclusion?: string | null; url?: string }[];
  reviews: { user?: string; state: string; body?: string }[];
  comments: { user?: string; at?: string; body: string }[];
  inline: { user?: string; path?: string; line?: number; body: string }[];
}
export interface Provider {
  defaultBranch(): Promise<string>;
  /** Open a PR; if one is already open for `head`, that one with `existing: true`. */
  create(a: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<Pr & { existing?: boolean }>;
  list(state: 'open' | 'closed' | 'all'): Promise<Pr[]>;
  get(n: number): Promise<PrDetail>;
  comment(n: number, body: string): Promise<{ url?: string }>;
}
export interface ProviderHost { name: string; provider?: ProviderName; token?: string; apiUrl?: string }
/** Runs a script on the git host (for `gh`). */
export type HostRun = (script: string, input?: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** Host and repo path (`owner/repo`, `group/sub/repo`) of an origin URL: https, ssh:// or scp-style. */
export function origin(r: { name: string; url?: string }): { host: string; path: string } {
  const u = r.url ?? '';
  const scp = /^[^/@:]+@([^/:]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(u);
  let host = '', path = '';
  if (scp) [host, path] = [scp[1], scp[2]];
  else try { const x = new URL(u); host = x.protocol.startsWith('http') ? x.host : x.hostname; path = x.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''); } catch { /* below */ }
  if (!host || !path.includes('/')) throw new Error(`cannot tell owner/repo from origin "${u}" of ${r.name}`);
  return { host, path };
}

/** API base: the host's API URL, else the forge's usual one for the origin's host. */
export function apiBase(p: ProviderName, h: ProviderHost, host: string) {
  if (h.apiUrl) return h.apiUrl.replace(/\/$/, '');
  if (p === 'github') return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  return `https://${host}/api/${p === 'gitlab' ? 'v4' : 'v1'}`;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** `gh api` on the host: same calls as the github provider, gh's login instead of a token. */
function ghApi(h: ProviderHost, host: string, path: string, run: HostRun): Api {
  const hostname = h.apiUrl ? (() => { try { return new URL(h.apiUrl!).hostname.replace(/^api\./, ''); } catch { return host; } })() : host;
  return async (method, p, body) => {
    const script = `command -v gh >/dev/null || { echo "gh is not installed on git host ${h.name.replace(/[^\w.-]/g, '')}" >&2; exit 127; }
GH_PROMPT_DISABLED=1 NO_COLOR=1 gh api ${hostname === 'github.com' ? '' : `--hostname ${sq(hostname)} `}-X ${method} -H 'X-GitHub-Api-Version: 2022-11-28' ${sq(`repos/${path}${p}`)}${body === undefined ? '' : ' --input -'}`;
    const r = await run(script, body === undefined ? undefined : JSON.stringify(body));
    const j: any = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    if (r.code !== 0) {
      const status = Number(/\(HTTP (\d{3})\)/.exec(r.stderr)?.[1] ?? 0);
      throw Object.assign(new Error(`gh ${method} ${p}: ${(r.stderr.trim() || j?.message || `exit ${r.code}`).split('\n')[0]}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`), { status, body: j });
    }
    return j;
  };
}

export function provider(h: ProviderHost, r: { name: string; url?: string }, signal?: AbortSignal, run?: HostRun): Provider {
  const p = h.provider ?? 'none';
  if (p === 'none') throw new Error(`git host "${h.name}" has no PR provider; set one (and a token) on the host to use PRs`);
  if (p === 'gh') {
    if (!run) throw new Error('the gh provider needs the git host');
    const o = origin(r);
    return githubLike(ghApi(h, o.host, o.path, run), false);
  }
  if (!h.token) throw new Error(`git host "${h.name}" has no API token; PRs and comments need one`);
  const o = origin(r);
  const token = h.token;
  const auth: Record<string, string> = p === 'github' ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : p === 'gitlab' ? { 'PRIVATE-TOKEN': token } : { Authorization: `token ${token}` };
  const root = `${apiBase(p, h, o.host)}${p === 'gitlab' ? `/projects/${encodeURIComponent(o.path)}` : `/repos/${o.path}`}`;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${root}${path}`, {
      method, signal, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...auth, 'User-Agent': 'MControlProgram', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = typeof j?.message === 'string' ? j.message : j?.message ? JSON.stringify(j.message) : j?.error ?? res.statusText;
      throw Object.assign(new Error(`${p} ${method} ${path}: ${res.status} ${msg}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`.split(token).join('***')), { status: res.status, body: j });
    }
    return j;
  };
  return p === 'gitlab' ? gitlab(api) : githubLike(api, p === 'gitea');
}

type Api = (method: string, path: string, body?: unknown) => Promise<any>;

/** GitHub, and Gitea / Forgejo, whose API copies it (no check runs or inline comments; draft = "WIP:" title). */
function githubLike(api: Api, gitea: boolean): Provider {
  const pr = (p: any): Pr => ({ number: p.number, title: p.title, state: p.merged || p.merged_at ? 'merged' : p.state, draft: p.draft ?? (gitea ? /^(WIP|\[WIP\]|Draft):?/i.test(p.title) : undefined),
    head: p.head?.ref, base: p.base?.ref, url: p.html_url, user: p.user?.login, updated: p.updated_at });
  return {
    defaultBranch: async () => (await api('GET', '')).default_branch,
    async create(a) {
      try {
        return pr(await api('POST', '/pulls', gitea ? { head: a.head, base: a.base, title: a.draft ? `WIP: ${a.title}` : a.title, body: a.body } : { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }));
      } catch (e: any) {
        if (!(e.status === 422 || e.status === 409) || !/already exists/i.test(JSON.stringify(e.body ?? ''))) throw e;
        const open = (await this.list('open')).find((x) => x.head === a.head);
        if (!open) throw e;
        return { ...open, existing: true };
      }
    },
    list: async (state) => (await api('GET', `/pulls?state=${state}&${gitea ? 'limit' : 'per_page'}=50`)).map(pr),
    async get(n) {
      const p = await api('GET', `/pulls/${n}`);
      const sha = p.head.sha;
      const [checks, status, reviews, comments, inline] = await Promise.all([
        gitea ? { check_runs: [] } : api('GET', `/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
        api('GET', `/commits/${sha}/status`).catch(() => ({ statuses: [] })),
        api('GET', `/pulls/${n}/reviews`),
        api('GET', `/issues/${n}/comments`),
        gitea ? [] : api('GET', `/pulls/${n}/comments?per_page=100`),
      ]);
      return {
        ...pr(p), headSha: sha, mergeable: p.mergeable, body: p.body,
        checks: [...checks.check_runs.map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
          ...(status.statuses ?? []).map((c: any) => ({ name: c.context, status: 'completed', conclusion: c.state ?? c.status, url: c.target_url }))],
        reviews: reviews.map((x: any) => ({ user: x.user?.login, state: x.state, body: x.body })),
        comments: comments.map((x: any) => ({ user: x.user?.login, at: x.created_at, body: x.body })),
        inline: inline.map((x: any) => ({ user: x.user?.login, path: x.path, line: x.line, body: x.body })),
      };
    },
    comment: async (n, body) => ({ url: (await api('POST', `/issues/${n}/comments`, { body })).html_url }),
  };
}

/** GitLab merge requests: `number` is the MR's iid; checks are its pipelines, reviews its approvals. */
function gitlab(api: Api): Provider {
  const pr = (m: any): Pr => ({ number: m.iid, title: m.title, state: m.state === 'opened' ? 'open' : m.state === 'merged' ? 'merged' : 'closed', draft: m.draft ?? m.work_in_progress,
    head: m.source_branch, base: m.target_branch, url: m.web_url, user: m.author?.username, updated: m.updated_at });
  return {
    defaultBranch: async () => (await api('GET', '')).default_branch,
    async create(a) {
      try {
        return pr(await api('POST', '/merge_requests', { source_branch: a.head, target_branch: a.base, title: a.draft ? `Draft: ${a.title}` : a.title, description: a.body }));
      } catch (e: any) {
        if (e.status !== 409) throw e;
        const [open] = await api('GET', `/merge_requests?state=opened&source_branch=${encodeURIComponent(a.head)}`);
        if (!open) throw e;
        return { ...pr(open), existing: true };
      }
    },
    list: async (state) => (await api('GET', `/merge_requests?state=${state === 'open' ? 'opened' : state}&per_page=50`)).map(pr),
    async get(n) {
      const m = await api('GET', `/merge_requests/${n}`);
      const [pipelines, approvals, notes] = await Promise.all([
        api('GET', `/merge_requests/${n}/pipelines`).catch(() => []),
        api('GET', `/merge_requests/${n}/approvals`).catch(() => ({ approved_by: [] })),
        api('GET', `/merge_requests/${n}/notes?per_page=100&sort=asc`),
      ]);
      const human = notes.filter((x: any) => !x.system);
      return {
        ...pr(m), headSha: m.sha, mergeable: m.merge_status ? m.merge_status === 'can_be_merged' : null, body: m.description,
        checks: pipelines.map((x: any) => ({ name: `pipeline #${x.id}`, status: x.status, conclusion: x.status, url: x.web_url })),
        reviews: (approvals.approved_by ?? []).map((x: any) => ({ user: x.user?.username, state: 'APPROVED' })),
        comments: human.filter((x: any) => !x.position).map((x: any) => ({ user: x.author?.username, at: x.created_at, body: x.body })),
        inline: human.filter((x: any) => x.position).map((x: any) => ({ user: x.author?.username, path: x.position.new_path, line: x.position.new_line, body: x.body })),
      };
    },
    async comment(n, body) {
      const note = await api('POST', `/merge_requests/${n}/notes`, { body });
      const m = await api('GET', `/merge_requests/${n}`).catch(() => null);
      return { url: m?.web_url ? `${m.web_url}#note_${note.id}` : undefined };
    },
  };
}
