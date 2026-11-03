# Dev log

## TODO

### GitHub plugin (proposed 2026-11-02)

Goal: agents work with GitHub through MCP without ever seeing SSH keys or tokens, with gating per repo and per kind of operation.

**SSH alone isn't enough.** GitHub over SSH only runs `git-upload-pack` (clone/fetch) and `git-receive-pack` (push). PRs, issues, and Actions workflows need the REST API. So the plugin has two halves, both with credentials stored as encrypted `x-secret` fields:

| Half | Credential | Covers |
|---|---|---|
| Git transport | SSH private key, plus GitHub's host key pinned like the ssh plugin's `hostKey` | clone, fetch, push |
| API | Fine-grained PAT or a GitHub App key (short-lived installation tokens) | PRs, issues, workflow runs, releases |

**Design: MCP acts as the agent's git remote.**

```
agent's checkout ──git push──▶ https://mcp.lan/git/<repo>.git   (agent's MCP bearer token)
                                   │  git http-backend (git's own smart-HTTP server)
                                   ▼
                           data/github/<repo>.git  (bare mirror)
                                   │  pre-receive hook = policy check
                                   ▼  GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<pinned>"
                               git@github.com:owner/repo.git
```

- The agent runs plain `git clone` and `git push` and only holds its existing MCP token, which can be revoked.
- The pre-receive hook gets `old new ref` for each update and enforces the policy:
  - deny unlisted refs (e.g. only `refs/heads/agent/*`)
  - deny deletes (`new == 000…`)
  - deny force-pushes (`git merge-base --is-ancestor old new`)
- The hook then pushes the refs to GitHub. A GitHub rejection fails the hook, so the agent's `git push` fails honestly.
  - **Verify:** that quarantined objects are readable from inside pre-receive. If they aren't, push to GitHub after the receive finishes.
- `git fetch` from GitHub into the mirror before serving a clone or fetch keeps reads current.

**Gating, from strongest to weakest:**

1. **GitHub enforces repo scope.** Use one deploy key per repo (read-only or read/write). A deploy key can't reach any other repo, even if MCP gets something wrong. Avoid personal SSH keys, which reach every repo. Branch protection stays as the backstop.
2. **Plugin policy per instance**, in the style of the web plugin's allow/deny rules:
   ```
   repos: [{ name: "MControlProgram", read: true, push: ["refs/heads/agent/*"], forcePush: false, delete: false }]
   api:   { allow: ["pr.create", "pr.comment", "issue.*", "actions.read"], deny: ["actions.dispatch", "release.*", "repo.settings"] }
   ```
3. **Existing approval gate.** API tools (`github_pr_create`, `github_pr_merge`, `github_workflow_dispatch`) leave `readOnlyHint` off when they write, so `src/core/approvals.ts` holds them for a human.

Log each push and API call like the web plugin's request log: who did it, the ref or endpoint, and whether it was allowed or blocked.

**Work needed:**

- [ ] Core: add plugin HTTP routes (e.g. `routes?: (req, res) => …` on `PluginInstance`), mounted at `/plugins/<instance>/…` behind MCP bearer-token auth. Plugins can't serve HTTP today.
- [ ] Dockerfile: add `git` to the runtime image (it only installs `openssh-client` now).
- [ ] `src/plugins/github/index.ts`: a push-only first version (mirror, pre-receive policy, upstream push). It doesn't depend on the ssh plugin; it uses system git with `GIT_SSH_COMMAND`.
- [ ] Second step: API tools backed by a PAT or GitHub App token.

**Rejected alternatives:**

- **Bundle-over-tool** (`github_push(repo, ref, bundle_base64)`): needs no core change, but agents handle base64 bundles badly and it's awkward for large pushes. Acceptable only as a stopgap.
- **SSH agent forwarding through MCP:** signing requests don't say which repo or ref is involved, so they can't be gated.
- **Running git on an ssh-plugin host:** the key would have to live on that host.
