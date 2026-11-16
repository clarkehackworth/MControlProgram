/**
 * PR providers: the REST calls behind create_pr / pr / comment / merge_pr / edit_pr / review_pr, per git host. Each returns the same shapes, so the
 * tools and agents don't care which forge is behind a repo. The token stays here: never on the git host or agents.
 */
/** `gh` = GitHub through the `gh` CLI on the git host, with its own login (`gh auth login` there): no token in MControlProgram. */
export const PROVIDERS = ['none', 'github', 'gh', 'gitlab', 'gitea'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface Pr { number: number; title: string; state: 'open' | 'closed' | 'merged'; draft?: boolean; head: string; base: string; url: string; user?: string; updated?: string }
export interface PrDetail extends Pr {
  headSha: string; mergeable?: boolean | null; body?: string; labels: string[]; assignees: string[]; reviewers_requested: string[];
  checks: { name: string; status: string; conclusion?: string | null; url?: string }[];
  reviews: { user?: string; state: string; body?: string }[];
  comments: { user?: string; at?: string; body: string }[];
  inline: { user?: string; path?: string; line?: number; body: string }[];
}
/** A GitHub stack: PRs chained base-to-head, listed from the bottom (merges first) to the top. */
export interface Stack { number: number; url?: string; open: boolean; base?: string; prs: { number: number; head?: string; state?: string; draft?: boolean; merged: boolean }[] }
/** A stack merge, which GitHub runs in the background: `pending` until it is `merged`, `enqueued` (merge queue) or `failed`. */
export interface StackMerge { status: string; uuid?: string; method?: string; action?: string; message?: string; sha?: string }
/** GitHub's stacked PRs (REST `/stacks`): only the `github` and `gh` providers have them. */
export interface Stacks {
  /** Newest first: up to `limit`, only open ones if `open`. */
  list(a: { open: boolean; limit: number }): Promise<Stack[]>;
  get(n: number): Promise<Stack>;
  /** The stack holding PR `pr`, or null. */
  forPr(pr: number): Promise<Stack | null>;
  /** `prs`: at least two, bottom to top, each based on the previous one's branch. */
  create(prs: number[]): Promise<Stack>;
  /** `prs`: only the new ones, from the current top upward. */
  add(n: number, prs: number[]): Promise<Stack>;
  /** Removes the grouping only: PRs and branches stay. `dissolved`: nothing was left in it. */
  unstack(n: number): Promise<{ dissolved: boolean; stack?: Stack }>;
  /** Merges PR `pr` and every unmerged PR below it. */
  merge(pr: number, a: { method?: 'merge' | 'squash' | 'rebase'; action?: 'default' | 'direct_merge' | 'merge_queue' }): Promise<StackMerge>;
  mergeStatus(pr: number, uuid: string): Promise<StackMerge>;
}
export interface Provider {
  defaultBranch(): Promise<string>;
  /** Stacked PRs (GitHub only). */
  stacks?: Stacks;
  /** Open a PR; if one is already open for `head`, that one with `existing: true`. */
  create(a: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<Pr & { existing?: boolean }>;
  list(state: 'open' | 'closed' | 'all'): Promise<Pr[]>;
  get(n: number): Promise<PrDetail>;
  comment(n: number, body: string): Promise<{ url?: string }>;
  /** `sha`: merge only if the head is still this commit. */
  merge(n: number, a: { method?: 'merge' | 'squash' | 'rebase'; sha?: string; title?: string; message?: string }): Promise<{ merged: boolean; sha?: string; message?: string }>;
  edit(n: number, e: PrEdit): Promise<PrDetail>;
  review(n: number, a: { event: 'approve' | 'request_changes' | 'comment'; body?: string }): Promise<{ url?: string }>;
}
export interface Delta { add?: string[]; remove?: string[] }
export interface PrEdit { title?: string; body?: string; base?: string; state?: 'open' | 'closed'; draft?: boolean; labels?: Delta; assignees?: Delta; reviewers?: Delta }
/** `cur` with `d` applied. */
export const delta = (cur: string[], d: Delta) => [...new Set([...cur.filter((x) => !d.remove?.includes(x)), ...(d.add ?? [])])];
const DRAFT = /^\s*(WIP|\[WIP\]|Draft)\s*:?\s*/i;
const draftTitle = (t: string, draft: boolean, mark: string) => (draft ? `${mark}: ` : '') + t.replace(DRAFT, '');
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
function ghCall(h: ProviderHost, host: string, run: HostRun) {
  const hostname = h.apiUrl ? (() => { try { return new URL(h.apiUrl!).hostname.replace(/^api\./, ''); } catch { return host; } })() : host;
  return async (method: string, endpoint: string, label: string, body: unknown): Promise<any> => {
    const script = `command -v gh >/dev/null || { echo "gh is not installed on git host ${h.name.replace(/[^\w.-]/g, '')}" >&2; exit 127; }
GH_PROMPT_DISABLED=1 NO_COLOR=1 gh api ${hostname === 'github.com' ? '' : `--hostname ${sq(hostname)} `}-X ${method} -H 'X-GitHub-Api-Version: 2022-11-28' ${sq(endpoint)}${body === undefined ? '' : ' --input -'}`;
    const r = await run(script, body === undefined ? undefined : JSON.stringify(body));
    const j: any = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    if (r.code !== 0) {
      const status = Number(/\(HTTP (\d{3})\)/.exec(r.stderr)?.[1] ?? 0);
      throw Object.assign(new Error(`gh ${method} ${label}: ${(r.stderr.trim() || j?.message || `exit ${r.code}`).split('\n')[0]}${j?.errors ? ' ' + JSON.stringify(j.errors) : ''}`), { status, body: j });
    }
    return j;
  };
}
function ghApi(h: ProviderHost, host: string, path: string, run: HostRun): Api {
  const call = ghCall(h, host, run);
  return (method, p, body) => call(method, `repos/${path}${p}`, p, body);
}
/** GitHub GraphQL through `gh api graphql`. */
function ghGraphql(h: ProviderHost, host: string, run: HostRun): Graphql {
  const call = ghCall(h, host, run);
  return async (query, variables) => graphqlData(await call('POST', 'graphql', 'graphql', { query, variables }));
}
/** The `data` of a GraphQL answer; its `errors` (sent with a 200) throw. */
function graphqlData(j: any) {
  if (j?.errors?.length) throw new Error(`graphql: ${j.errors.map((e: any) => e.message).join('; ')}`);
  return j?.data;
}

export function provider(h: ProviderHost, r: { name: string; url?: string }, signal?: AbortSignal, run?: HostRun): Provider {
  const p = h.provider ?? 'none';
  if (p === 'none') throw new Error(`git host "${h.name}" has no PR provider; set one (and a token) on the host to use PRs`);
  if (p === 'gh') {
    if (!run) throw new Error('the gh provider needs the git host');
    const o = origin(r);
    return githubLike(ghApi(h, o.host, o.path, run), false, ghGraphql(h, o.host, run));
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
  // GitHub's REST API can't change draft status: GraphQL can. github.com: api.github.com/graphql; Enterprise: https://host/api/graphql
  const gqlUrl = h.apiUrl ? `${h.apiUrl.replace(/\/$/, '').replace(/\/v3$/, '')}/graphql` : o.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${o.host}/api/graphql`;
  const graphql: Graphql = async (query, variables) => {
    const res = await fetch(gqlUrl, { method: 'POST', signal, body: JSON.stringify({ query, variables }), headers: { ...auth, 'User-Agent': 'MControlProgram', 'Content-Type': 'application/json' } });
    const j: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`github graphql: ${res.status} ${j?.message ?? res.statusText}`.split(token).join('***'));
    try { return graphqlData(j); } catch (e: any) { throw new Error(String(e.message).split(token).join('***')); }
  };
  return p === 'gitlab' ? gitlab(api) : githubLike(api, p === 'gitea', p === 'github' ? graphql : undefined);
}

type Api = (method: string, path: string, body?: unknown) => Promise<any>;
type Graphql = (query: string, variables: Record<string, unknown>) => Promise<any>;

/** GitHub, and Gitea / Forgejo, whose API copies it (no check runs or inline comments; draft = "WIP:" title). */
function githubLike(api: Api, gitea: boolean, graphql?: Graphql): Provider {
  const pr = (p: any): Pr => ({ number: p.number, title: p.title, state: p.merged || p.merged_at ? 'merged' : p.state, draft: p.draft ?? (gitea ? /^(WIP|\[WIP\]|Draft):?/i.test(p.title) : undefined),
    head: p.head?.ref, base: p.base?.ref, url: p.html_url, user: p.user?.login, updated: p.updated_at });
  const stack = (x: any): Stack => ({ number: x.number, url: x.url, open: !!x.open, base: x.base?.ref,
    prs: (x.pull_requests ?? []).map((q: any) => ({ number: q.number, head: q.head?.ref, state: q.state, draft: q.draft, merged: !!q.merged_at })) });
  // a 404 on /stacks: the feature is off for the repo (or the login can't see it)
  const stackCall = async (method: string, path: string, body?: unknown) => {
    try { return await api(method, path, body); } catch (e: any) {
      if (e.status === 404) throw new Error('stacked PRs are not enabled for this repository (or this login cannot use them)');
      throw e;
    }
  };
  const stacks: Stacks = {
    // ponytail: the API has no state filter, so open ones are picked here; scans at most 500 stacks
    async list(a) {
      const all: Stack[] = [];
      for (let page = 1; page <= 5 && all.length < a.limit; page++) {
        const batch: any[] = await stackCall('GET', `/stacks?per_page=100&page=${page}`);
        all.push(...batch.map(stack).filter((x) => !a.open || x.open));
        if (batch.length < 100) break;
      }
      return all.slice(0, a.limit);
    },
    get: async (n) => stack(await stackCall('GET', `/stacks/${n}`)),
    async forPr(n) { const [x] = await stackCall('GET', `/stacks?pull_request=${n}`); return x ? stack(x) : null; },
    create: async (prs) => stack(await stackCall('POST', '/stacks', { pull_requests: prs })),
    add: async (n, prs) => stack(await stackCall('POST', `/stacks/${n}/add`, { pull_requests: prs })),
    async unstack(n) { const x = await stackCall('POST', `/stacks/${n}/unstack`); return x ? { dissolved: false, stack: stack(x) } : { dissolved: true }; },
    async merge(n, a) {
      let r: any;
      try { r = await api('PUT', `/pulls/${n}/merge-async`, { merge_method: a.method, merge_action: a.action ?? 'default' }); } catch (e: any) {
        if (e.status === 404) throw new Error('merging a stack is not available for this repository');
        if (e.status === 409) throw new Error('a merge request already exists for this stack');
        if (e.status === 400) throw new Error('the stack can no longer be merged as requested; read it again (stack) and retry');
        throw e;
      }
      return mergeResult(r);
    },
    mergeStatus: async (n, uuid) => mergeResult(await api('GET', `/pulls/${n}/merge-async/${encodeURIComponent(uuid)}`)),
  };
  const mergeResult = (r: any): StackMerge => ({ status: r?.status, uuid: r?.details?.uuid, method: r?.details?.merge_method, action: r?.details?.merge_action, message: r?.details?.message, sha: r?.details?.sha });
  return {
    ...(gitea ? {} : { stacks }),
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
        labels: (p.labels ?? []).map((x: any) => x.name), assignees: (p.assignees ?? []).map((x: any) => x.login), reviewers_requested: (p.requested_reviewers ?? []).map((x: any) => x.login),
        checks: [...checks.check_runs.map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
          ...(status.statuses ?? []).map((c: any) => ({ name: c.context, status: 'completed', conclusion: c.state ?? c.status, url: c.target_url }))],
        reviews: reviews.map((x: any) => ({ user: x.user?.login, state: x.state, body: x.body })),
        comments: comments.map((x: any) => ({ user: x.user?.login, at: x.created_at, body: x.body })),
        inline: inline.map((x: any) => ({ user: x.user?.login, path: x.path, line: x.line, body: x.body })),
      };
    },
    comment: async (n, body) => ({ url: (await api('POST', `/issues/${n}/comments`, { body })).html_url }),
    async merge(n, a) {
      if (!gitea) {
        const r = await api('PUT', `/pulls/${n}/merge`, { merge_method: a.method ?? 'merge', sha: a.sha, commit_title: a.title, commit_message: a.message });
        return { merged: !!r.merged, sha: r.sha, message: r.message };
      }
      await api('POST', `/pulls/${n}/merge`, { Do: a.method ?? 'merge', head_commit_id: a.sha, MergeTitleField: a.title, MergeMessageField: a.message });
      const p = await api('GET', `/pulls/${n}`);
      return { merged: !!p.merged, sha: p.merge_commit_sha };
    },
    async edit(n, e) {
      const cur = e.draft !== undefined || (gitea && e.assignees) ? await api('GET', `/pulls/${n}`) : undefined;
      const patch: Record<string, unknown> = { title: e.title, body: e.body, base: e.base, state: e.state };
      if (e.draft !== undefined) {
        if (!gitea) {
          if (!!cur.draft !== e.draft) {
            if (!graphql) throw new Error('changing draft status needs GraphQL, which this provider has no access to');
            await graphql(`mutation($id: ID!) { ${e.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'}(input: { pullRequestId: $id }) { pullRequest { id } } }`, { id: cur.node_id });
          }
        } else patch.title = draftTitle(e.title ?? cur.title, e.draft, 'WIP');
      }
      // Gitea sets assignees as a whole list
      if (gitea && e.assignees) patch.assignees = delta((cur.assignees ?? []).map((x: any) => x.login), e.assignees);
      if (Object.values(patch).some((v) => v !== undefined)) await api('PATCH', `/pulls/${n}`, patch);
      // Gitea labels are ids
      const ids = async (names: string[]) => {
        if (!gitea) return names;
        const all: any[] = await api('GET', '/labels?limit=50');
        return names.map((l) => all.find((x) => x.name === l)?.id ?? (() => { throw new Error(`no label "${l}" in the repo`); })());
      };
      if (e.labels?.add?.length) await api('POST', `/issues/${n}/labels`, { labels: await ids(e.labels.add) });
      for (const l of e.labels?.remove?.length ? await ids(e.labels.remove) : []) await api('DELETE', `/issues/${n}/labels/${encodeURIComponent(l)}`);
      if (!gitea && e.assignees?.add?.length) await api('POST', `/issues/${n}/assignees`, { assignees: e.assignees.add });
      if (!gitea && e.assignees?.remove?.length) await api('DELETE', `/issues/${n}/assignees`, { assignees: e.assignees.remove });
      if (e.reviewers?.add?.length) await api('POST', `/pulls/${n}/requested_reviewers`, { reviewers: e.reviewers.add });
      if (e.reviewers?.remove?.length) await api('DELETE', `/pulls/${n}/requested_reviewers`, { reviewers: e.reviewers.remove });
      return this.get(n);
    },
    review: async (n, a) => ({ url: (await api('POST', `/pulls/${n}/reviews`, { event: a.event === 'approve' ? (gitea ? 'APPROVED' : 'APPROVE') : a.event.toUpperCase(), body: a.body ?? '' })).html_url }),
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
        labels: m.labels ?? [], assignees: (m.assignees ?? []).map((x: any) => x.username), reviewers_requested: (m.reviewers ?? []).map((x: any) => x.username),
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
    async merge(n, a) {
      if (a.method === 'rebase') throw new Error("GitLab: merge commit vs fast-forward is the project's merge method; use merge or squash");
      const msg = [a.title, a.message].filter(Boolean).join('\n\n') || undefined;
      const m = await api('PUT', `/merge_requests/${n}/merge`, { squash: a.method === 'squash', sha: a.sha, ...(a.method === 'squash' ? { squash_commit_message: msg } : { merge_commit_message: msg }) });
      return { merged: m.state === 'merged', sha: m.merge_commit_sha ?? m.squash_commit_sha ?? undefined };
    },
    async edit(n, e) {
      const m = await api('GET', `/merge_requests/${n}`);
      // GitLab takes user ids: look them up among the project's members
      const ids = (names: string[]) => Promise.all(names.map(async (u) => {
        const x = (await api('GET', `/members/all?query=${encodeURIComponent(u)}`)).find((y: any) => y.username === u);
        if (!x) throw new Error(`no member "${u}" in the project`);
        return x.id;
      }));
      await api('PUT', `/merge_requests/${n}`, {
        title: e.draft === undefined ? e.title : draftTitle(e.title ?? m.title, e.draft, 'Draft'), description: e.body, target_branch: e.base,
        state_event: e.state && (e.state === 'closed' ? 'close' : 'reopen'), add_labels: e.labels?.add?.join(','), remove_labels: e.labels?.remove?.join(','),
        assignee_ids: e.assignees && await ids(delta((m.assignees ?? []).map((x: any) => x.username), e.assignees)),
        reviewer_ids: e.reviewers && await ids(delta((m.reviewers ?? []).map((x: any) => x.username), e.reviewers)),
      });
      return this.get(n);
    },
    async review(n, a) {
      // ponytail: GitLab's REST API has no request-changes review; approve + comment cover it
      if (a.event === 'request_changes') throw new Error('GitLab has no request-changes review: comment instead');
      if (a.event === 'approve') await api('POST', `/merge_requests/${n}/approve`, {});
      return a.body ? this.comment(n, a.body) : {};
    },
  };
}
