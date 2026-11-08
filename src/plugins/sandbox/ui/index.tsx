import { Fragment, useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Field, LoadingRow, Modal, api, useAction, type PluginUi } from '@mcontrolprogram/ui'

interface Port { host_ip?: string; host_port: number; sandbox_port: number; protocol?: string }
interface Sandbox { name: string; agent: string; status: string; ports?: Port[]; workspaces?: string[]; created_at?: string; last_used_at?: string }
interface Rule { id: string; decision: string; resources: string[]; scope: string; resource_type?: string; layer?: string; editable?: boolean; status?: string }
interface Conn { sandbox_id: string; host: string; count: number; last_seen: string; rule?: string; reason?: string; allowed: boolean }
interface HostCfg { name: string; workspaceRoots?: string[] }

// open sandbox row + its expansion read as one block
const OPEN_ROW = { background: 'var(--bg3)' }
const OPEN_EDGE = { boxShadow: 'inset 3px 0 0 var(--accent)' }
const AGENTS = ['shell', 'claude', 'codex', 'cursor', 'devin', 'docker-agent', 'gemini', 'opencode']
/** Run an agent tool from the admin page (server-side `call` action). */
const tool = <T = any,>(host: string, name: string, args: Record<string, unknown> = {}) =>
  api<{ result: T }>('/plugins/sandbox/actions/call', { method: 'POST', body: { tool: name, args: { host, ...args } } }).then((r) => r.result)
const portStr = (p: Port) => `${p.host_ip && p.host_ip !== '0.0.0.0' ? p.host_ip + ':' : ''}${p.host_port}→${p.sandbox_port}`

/** Docker Sandboxes: per host, the sandboxes (create/stop/remove, ports, run a command, files) and the network policy & log. */
function SandboxPage({ plugin, selected }: { plugin: { globalConfig?: Record<string, any> }; selected: Record<string, string | undefined> }) {
  const h = ((plugin.globalConfig?.hosts ?? []) as HostCfg[]).find((x) => x.name === selected.hosts)
  if (!h) return <div className="card muted">Add a sandbox host above to manage its sandboxes here.</div>
  return <HostView key={h.name} h={h} />
}

function HostView({ h }: { h: HostCfg }) {
  const [list, setList] = useState<Sandbox[]>()
  const [sel, setSel] = useState<string>()
  const [creating, setCreating] = useState(false)
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => setList(await tool<Sandbox[]>(h.name, 'list'))), [h.name]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const act = (name: string, sandbox: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    void run(async () => { await tool(h.name, name, { sandbox }); if (name === 'remove' && sel === sandbox) setSel(undefined); await load() })
  }
  const start = (sandbox: string) => run(async () => { await tool(h.name, 'exec', { sandbox, command: 'true' }); await load() })

  return (
    <>
      <style>{'tr.sbx-open > td { border-bottom: 0 }'}</style>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Sandboxes <span className="muted small">on {h.name}</span></h2>
          <div className="row">
            <button className="sm" onClick={load} disabled={busy}>Refresh</button>
            <button className="sm primary" onClick={() => setCreating(true)}>+ Create sandbox</button>
          </div>
        </div>
        {error && <Alert kind="err">{error}</Alert>}
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Name</th><th>Agent</th><th>Status</th><th>Ports</th><th>Workspaces</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {list?.map((s) => <Fragment key={s.name}>
            <tr className={sel === s.name ? 'sbx-open' : undefined} style={sel === s.name ? OPEN_ROW : { cursor: 'pointer' }} onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setSel(sel === s.name ? undefined : s.name) }}>
              <td className="mono" style={sel === s.name ? OPEN_EDGE : undefined}><span className="muted">{sel === s.name ? '▾' : '▸'}</span> {s.name}</td>
              <td>{s.agent}</td>
              <td><Badge kind={s.status === 'running' ? 'ok' : undefined}>{s.status}</Badge></td>
              <td className="mono small">{s.ports?.map(portStr).join(', ') || '—'}</td>
              <td className="mono small">{s.workspaces?.join(', ') || '—'}</td>
              <td className="small muted">{s.last_used_at ? new Date(s.last_used_at).toLocaleString() : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {s.status === 'running'
                  ? <button className="sm" disabled={busy} onClick={() => act('stop', s.name)}>Stop</button>
                  : <button className="sm" disabled={busy} onClick={() => void start(s.name)} title="Starts it by running a no-op command">Start</button>}
                {' '}<button className="sm danger" disabled={busy} onClick={() => act('remove', s.name, `Delete sandbox ${s.name} and everything inside it?\n\nMounted workspaces on the host are kept.`)}>Remove</button>
              </td>
            </tr>
            {sel === s.name && <tr style={{ background: OPEN_ROW.background }}>
              <td colSpan={7} style={{ ...OPEN_EDGE, padding: '4px 16px 16px 26px' }}><SandboxDetail host={h.name} s={s} reload={load} /></td>
            </tr>}
            </Fragment>)}
            {list?.length === 0 && <tr><td colSpan={7} className="muted">No sandboxes.</td></tr>}
            {!list && (busy ? <LoadingRow cols={7} /> : <tr><td colSpan={7} className="muted">—</td></tr>)}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Click a host above to switch hosts. Click a sandbox to run commands and manage its ports; the policy and log below then show only that sandbox. Workspace roots: {h.workspaceRoots?.length ? <span className="mono">{h.workspaceRoots.join(', ')}</span> : 'none (no host file access for agents)'}.</p>
      </div>
      <Policy host={h.name} sandbox={sel} />
      <NetLog host={h.name} sandbox={sel} />
      {creating && <CreateDialog h={h} onClose={() => setCreating(false)} onDone={async (name) => { setCreating(false); await load(); setSel(name) }} />}
    </>
  )
}

function CreateDialog({ h, onClose, onDone }: { h: HostCfg; onClose: () => void; onDone: (name: string) => Promise<void> }) {
  const [f, setF] = useState({ name: '', agent: 'shell', workspaces: '', publish: '', cpus: '', memory: '', denyNetwork: '' })
  const { run, error, busy } = useAction()
  const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  const submit = () => run(async () => {
    await tool(h.name, 'create', {
      name: f.name, agent: f.agent,
      workspaces: lines(f.workspaces).map((w) => w.endsWith(':ro') ? { path: w.slice(0, -3), readOnly: true } : { path: w }),
      publish: lines(f.publish), denyNetwork: lines(f.denyNetwork),
      ...(f.cpus ? { cpus: Number(f.cpus) } : {}), ...(f.memory ? { memory: f.memory } : {}),
    })
    await onDone(f.name)
  })
  return (
    <Modal title={`Create sandbox on ${h.name}`} onClose={onClose}>
      <Field label="Name" desc="Letters, digits, - and ."><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Agent"><select value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}>{AGENTS.map((a) => <option key={a}>{a}</option>)}</select></Field>
      <Field label="Workspaces" desc={`Host directories mounted at the same path, one per line; add :ro for read-only (not on the first one). Must be inside a workspace root (${h.workspaceRoots?.join(', ') || 'none configured'}).`}>
        <textarea rows={2} value={f.workspaces} onChange={(e) => setF({ ...f, workspaces: e.target.value })} placeholder="/srv/work/project" /></Field>
      <Field label="Publish ports" desc="[[HOST_IP:]HOST_PORT:]SANDBOX_PORT, comma separated"><input type="text" value={f.publish} onChange={(e) => setF({ ...f, publish: e.target.value })} placeholder="8080, 127.0.0.1:3000:3000" /></Field>
      <div className="row" style={{ gap: 12 }}>
        <Field label="CPUs" desc="Empty = auto"><input type="number" min={0} value={f.cpus} onChange={(e) => setF({ ...f, cpus: e.target.value })} /></Field>
        <Field label="Memory" desc="e.g. 4g; empty = default"><input type="text" value={f.memory} onChange={(e) => setF({ ...f, memory: e.target.value })} /></Field>
      </div>
      <Field label="Deny network" desc="Hosts this sandbox may never reach, comma separated"><input type="text" value={f.denyNetwork} onChange={(e) => setF({ ...f, denyNetwork: e.target.value })} /></Field>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !f.name} onClick={() => void submit()}>{busy ? 'Creating… (can take a minute)' : 'Create'}</button>
      </div>
    </Modal>
  )
}

/** Expanded inside the sandbox's table row: command console and ports. */
function SandboxDetail({ host, s, reload }: { host: string; s: Sandbox; reload: () => Promise<void> }) {
  const [cmd, setCmd] = useState('')
  const [out, setOut] = useState<string>()
  const [port, setPort] = useState('')
  const { run, error, busy } = useAction()
  const exec = () => run(async () => { setOut(String(await tool(host, 'exec', { sandbox: s.name, command: cmd }))) })
  const ports = (k: 'publish' | 'unpublish', spec: string) => run(async () => { await tool(host, 'ports', { sandbox: s.name, [k]: [spec] }); setPort(''); await reload() })
  const label = { width: 110, flex: 'none', paddingTop: 7 } as const

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="small muted">Created {s.created_at ? new Date(s.created_at).toLocaleString() : '?'}</div>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="small" style={label}>Command</span>
        <div style={{ flex: 1, display: 'grid', gap: 6 }}>
          <div className="row">
            <input type="text" className="mono" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && cmd && void exec()} placeholder="ls -la /workspace" style={{ flex: 1 }} />
            <button className="sm primary" disabled={busy || !cmd} onClick={() => void exec()}>{busy && cmd ? 'Running…' : 'Run'}</button>
          </div>
          <span className="small muted">sh -c inside the sandbox; starts it if stopped. No TTY or stdin.</span>
          {out !== undefined && <pre style={{ maxHeight: 320 }}>{out}</pre>}
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="small" style={label}>Ports</span>
        <div className="row" style={{ flex: 1, flexWrap: 'wrap' }}>
          <div className="chips">
            {s.ports?.map((p) => <span key={portStr(p)} className="chip mono">{portStr(p)}<a href="#" title="Unpublish" onClick={(e) => { e.preventDefault(); void ports('unpublish', `${p.host_port}:${p.sandbox_port}`) }}>✕</a></span>)}
          </div>
          <input type="text" className="mono" value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && port && void ports('publish', port)} placeholder="[HOST_PORT:]SANDBOX_PORT" style={{ width: 220 }} />
          <button className="sm" disabled={busy || !port} onClick={() => void ports('publish', port)}>Publish</button>
        </div>
      </div>
    </div>
  )
}

/** Policy card: network rules (editable) and filesystem rules (read-only: sbx has no CLI to change them). */
function Policy({ host, sandbox }: { host: string; sandbox?: string }) {
  const [tab, setTab] = useState<'network' | 'filesystem'>('network')
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Policy <span className="muted small">{sandbox ? `rules that apply to ${sandbox}` : 'all rules'}</span></h2>
      </div>
      <div className="tabs" style={{ margin: '8px 0 12px' }}>
        {(['network', 'filesystem'] as const).map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t === 'network' ? 'Network' : 'Filesystem'}</button>)}
      </div>
      {tab === 'network' ? <NetworkRules host={host} sandbox={sandbox} /> : <FsRules host={host} sandbox={sandbox} />}
    </div>
  )
}

function FsRules({ host, sandbox }: { host: string; sandbox?: string }) {
  const [rules, setRules] = useState<Rule[]>()
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    setRules((await tool<{ rules: Rule[] }>(host, 'policy', { type: 'filesystem', ...(sandbox ? { sandbox } : {}) })).rules ?? [])
  }), [host, sandbox]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted small">Which host paths sandboxes may mount, read-only or read/write. Set by sbx defaults or your organisation's policy; the sbx CLI can't change them.</span>
        <button className="sm" onClick={load} disabled={busy}>Refresh</button>
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <table>
        <thead><tr><th>Decision</th><th>Access</th><th>Paths</th><th>Scope</th><th>Layer</th></tr></thead>
        <tbody>
          {rules?.map((r) => <tr key={r.id}>
            <td><Badge kind={r.decision === 'allow' ? 'ok' : 'err'}>{r.decision}</Badge></td>
            <td className="small">{r.resource_type?.replace(/^filesystem:/, '') ?? ''}</td>
            <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{r.resources.join(', ')}</td>
            <td className="small">{r.scope.replace(/^sandbox:/, '')}</td>
            <td className="small muted">{r.layer}{r.editable === false ? ' · built-in' : ''}{r.status && r.status !== 'active' ? ` (${r.status})` : ''}</td>
          </tr>)}
          {rules?.length === 0 && <tr><td colSpan={5} className="muted">No filesystem rules.</td></tr>}
          {!rules && (busy ? <LoadingRow cols={5} /> : <tr><td colSpan={5} className="muted">—</td></tr>)}
        </tbody>
      </table>
    </>
  )
}

function NetworkRules({ host, sandbox }: { host: string; sandbox?: string }) {
  const [rules, setRules] = useState<Rule[]>()
  const [add, setAdd] = useState({ resources: '', decision: 'allow', scope: 'global' })
  const [check, setCheck] = useState({ target: '', result: undefined as any })
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    setRules((await tool<{ rules: Rule[] }>(host, 'policy', { type: 'network', ...(sandbox ? { sandbox } : {}) })).rules ?? [])
  }), [host, sandbox]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const scoped = add.scope === 'sandbox' && sandbox
  const addRule = () => run(async () => { await tool(host, `network_${add.decision}`, { resources: add.resources, ...(scoped ? { sandbox } : {}) }); setAdd({ ...add, resources: '' }); await load() })
  const remove = (r: Rule) => { if (window.confirm(`Remove ${r.decision} rule for ${r.resources.join(', ')}?`)) void run(async () => { await tool(host, 'network_remove', { id: r.id }); await load() }) }
  const doCheck = () => run(async () => setCheck({ ...check, result: await tool(host, 'network_check', { target: check.target, ...(sandbox ? { sandbox } : {}) }) }))

  return (
    <>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={add.decision} onChange={(e) => setAdd({ ...add, decision: e.target.value })} style={{ width: 100 }}><option value="allow">Allow</option><option value="deny">Deny</option></select>
        <input type="text" className="mono" value={add.resources} onChange={(e) => setAdd({ ...add, resources: e.target.value })} placeholder="api.example.com, *.github.com" style={{ flex: 1 }} />
        <select value={scoped ? 'sandbox' : 'global'} onChange={(e) => setAdd({ ...add, scope: e.target.value })} style={{ width: 180 }}>
          <option value="global">All sandboxes</option>{sandbox && <option value="sandbox">Only {sandbox}</option>}
        </select>
        <button className="sm primary" disabled={busy || !add.resources} onClick={() => void addRule()}>Add rule</button>
        <button className="sm" onClick={load} disabled={busy}>Refresh</button>
      </div>
      <table>
        <thead><tr><th>Decision</th><th>Hosts</th><th>Scope</th><th>Layer</th><th /></tr></thead>
        <tbody>
          {rules?.map((r) => <tr key={r.id}>
            <td><Badge kind={r.decision === 'allow' ? 'ok' : 'err'}>{r.decision}</Badge></td>
            <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{r.resources.join(', ')}</td>
            <td className="small">{r.scope.replace(/^sandbox:/, '')}</td>
            <td className="small muted">{r.layer}{r.status && r.status !== 'active' ? ` (${r.status})` : ''}</td>
            <td>{r.editable === false ? <span className="muted small">built-in</span> : <button className="sm danger" disabled={busy} onClick={() => remove(r)}>Remove</button>}</td>
          </tr>)}
          {rules?.length === 0 && <tr><td colSpan={5} className="muted">No network rules.</td></tr>}
          {!rules && busy && <LoadingRow cols={5} />}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <input type="text" className="mono" value={check.target} onChange={(e) => setCheck({ target: e.target.value, result: undefined })} placeholder="Check a host or URL: github.com" style={{ flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && check.target && void doCheck()} />
        <button className="sm" disabled={busy || !check.target} onClick={() => void doCheck()}>Check</button>
        {check.result && <span>{check.result.allowed ? <Badge kind="ok">allowed</Badge> : <Badge kind="err">blocked</Badge>} <span className="muted small">{check.result.reason}</span></span>}
      </div>
    </>
  )
}

function NetLog({ host, sandbox }: { host: string; sandbox?: string }) {
  const [rows, setRows] = useState<Conn[]>()
  const [live, setLive] = useState(false)
  const [only, setOnly] = useState('')
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    const r = await tool<{ allowed?: Omit<Conn, 'allowed'>[]; blocked?: Omit<Conn, 'allowed'>[] }>(host, 'network_log', { limit: 200, ...(sandbox ? { sandbox } : {}) })
    setRows([...(r.blocked ?? []).map((c) => ({ ...c, allowed: false })), ...(r.allowed ?? []).map((c) => ({ ...c, allowed: true }))].sort((a, b) => b.last_seen.localeCompare(a.last_seen)))
  }), [host, sandbox]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load()
    if (!live) return
    const t = setInterval(() => void load(), 10000)
    return () => clearInterval(t)
  }, [load, live])
  const shown = rows?.filter((r) => !only || (only === 'blocked') !== r.allowed)
  const allowHost = (r: Conn) => { const h = r.host.replace(/:\d+$/, ''); if (window.confirm(`Allow ${h} for ${r.sandbox_id}?`)) void run(async () => { await tool(host, 'network_allow', { resources: h, sandbox: r.sandbox_id }); await load() }) }
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Network log <span className="muted small">{sandbox ?? 'all sandboxes'}</span></h2>
        <div className="row">
          <select value={only} onChange={(e) => setOnly(e.target.value)} style={{ width: 160 }}><option value="">Allowed & blocked</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option></select>
          <label className="toggle small"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Auto-refresh</label>
          <button className="sm" onClick={load} disabled={busy}>Refresh</button>
        </div>
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>Last seen</th><th>Sandbox</th><th>Host</th><th>Outcome</th><th>Count</th><th /></tr></thead>
        <tbody>
          {shown?.map((r) => <tr key={`${r.allowed}${r.sandbox_id}${r.host}`}>
            <td className="ts small">{new Date(r.last_seen).toLocaleString()}</td>
            <td className="small">{r.sandbox_id}</td>
            <td className="mono small">{r.host}</td>
            <td>{r.allowed ? <Badge kind="ok">allowed</Badge> : <><Badge kind="err">blocked</Badge> <span className="muted small">{r.reason}</span></>}</td>
            <td className="small">{r.count}</td>
            <td>{!r.allowed && <button className="sm" disabled={busy} onClick={() => allowHost(r)}>Allow host</button>}</td>
          </tr>)}
          {shown?.length === 0 && <tr><td colSpan={6} className="muted">No connections logged.</td></tr>}
          {!rows && busy && <LoadingRow cols={6} />}
        </tbody>
      </table>
    </div>
  )
}

const ui: PluginUi = { Page: SandboxPage, inventory: { hosts: { selectable: true } } }
export default ui
