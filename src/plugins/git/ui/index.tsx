import { useEffect, useRef, useState } from 'react'
import { Alert, Field, Modal, api, type PluginUi } from '@mcontrolprogram/ui'
import { ToolRules } from '@plugin/mcp'

const act = <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/git/actions/${key}`, { method: 'POST', body }).then((r) => r.result)
interface Scan { added: string[]; removed: string[]; errors: Record<string, string> }

/** Repos come from the git hosts: rescan when the page opens (saves only on change), plus Rescan and Clone buttons. */
function RepoButtons({ reload }: { reload: () => Promise<void> }) {
  const [msg, setMsg] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [cloning, setCloning] = useState(false)
  const once = useRef(false)
  const rescan = async (quiet = false) => {
    setBusy(true)
    try {
      const r = await act<Scan>('scan', {})
      const errs = Object.entries(r.errors).map(([h, e]) => `${h}: ${e}`)
      setMsg([r.added.length && `added ${r.added.join(', ')}`, r.removed.length && `removed ${r.removed.join(', ')}`, ...errs].filter(Boolean).join('; ') || (quiet ? undefined : 'no changes'))
      if (r.added.length || r.removed.length) await reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { if (!once.current) { once.current = true; void rescan(true) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    {msg && <span className="muted small">{msg}</span>}
    <button disabled={busy} onClick={() => void rescan()}>{busy ? 'Scanning…' : 'Rescan'}</button>
    <button className="primary" onClick={() => setCloning(true)}>Clone repo…</button>
    {cloning && <CloneDialog onClose={() => setCloning(false)} onDone={async (m) => { setCloning(false); setMsg(m); await reload() }} />}
  </>
}

function CloneDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [hosts, setHosts] = useState<string[]>([])
  const [f, setF] = useState({ host: '', url: '', name: '' })
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api<{ id: string; globalConfig?: { hosts?: { name: string }[] } }[]>('/plugins').then((ps) => {
      const hs = (ps.find((p) => p.id === 'git')?.globalConfig?.hosts ?? []).map((h) => h.name)
      setHosts(hs); setF((x) => ({ ...x, host: x.host || hs[0] || '' }))
    })
  }, [])
  const go = async () => {
    setBusy(true); setErr(undefined)
    try { const r = await act<Scan & { dir: string }>('clone', f); await onDone(`cloned ${r.dir}`) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return <Modal title="Clone repo" onClose={onClose}>
    {err && <Alert kind="err">{err}</Alert>}
    {!hosts.length && <Alert kind="err">Add a git host first.</Alert>}
    <Field label="Git host"><select value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })}>{hosts.map((h) => <option key={h}>{h}</option>)}</select></Field>
    <Field label="Clone URL" desc="git@host:owner/repo.git uses the host's ssh key (run Set up host first). https:// works for public repos."><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value.trim() })} autoFocus /></Field>
    <Field label="Directory (optional)" desc="Default: the repo name. Becomes the repo's name for agents."><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.trim() })} /></Field>
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !f.host || !f.url} onClick={() => void go()}>{busy ? 'Cloning…' : 'Clone'}</button>
    </div>
  </Modal>
}

const ui: PluginUi = {
  inventory: { repos: { AddButton: RepoButtons } },
  Page: ({ plugin }) => <ToolRules plugin="git" groupLabel="repo" refresh="tool_rules"
    upstreams={((plugin.globalConfig?.repos ?? []) as { name: string }[]).map((r) => r.name)} />,
  asks: {
    // one call asks once for every feature it touches (push + force + sensitive paths): Enable/Disable sets them all
    direct: (a) => a.feature === 'git_tool',
    setRule: async (a, rule) => {
      for (const tool of (a.subject?.features ?? [a.subject?.tool]) as string[])
        await api(`/plugins/git/actions/set_tool_rule`, { method: 'POST', body: { upstream: a.subject?.upstream, tool, action: rule } })
    },
  },
}
export default ui
