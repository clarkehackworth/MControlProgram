import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, fmtTime, useApi, type ApprovalPolicy, type Instance, type InstanceStatus, type PluginMeta, type Server } from '../api'
import { Alert, Badge, CopyButton, Field, Json, Modal, useAction } from '../components/ui'
import SchemaForm, { defaultsFor } from '../components/SchemaForm'
import { AuthSelect, LogSelect } from './Servers'
import { LogTable } from './Logs'

const TABS = ['General', 'Plugins', 'Access', 'Sessions', 'Logs'] as const

export default function ServerDetail() {
  const { id } = useParams()
  const [server, reload, err] = useApi<Server>(`/servers/${id}`, 5000)
  const [tab, setTab] = useState<(typeof TABS)[number]>('General')
  if (err) return <Alert kind="err">{err}</Alert>
  if (!server) return null
  const st = server.status
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div><h1 style={{ margin: 0 }}>{server.name}</h1><div className="muted mono small">{st.url ?? `http://${server.host}:${server.port}/mcp`}</div></div>
        <div className="row">{st.running ? <Badge kind="ok">running since {fmtTime(st.startedAt)}</Badge> : <Badge kind={st.error ? 'err' : undefined}>{st.error ? `error: ${st.error}` : 'stopped'}</Badge>}</div>
      </div>
      <div className="tabs">{TABS.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}{t === 'Sessions' && st.sessions.length ? ` (${st.sessions.length})` : ''}</button>)}</div>
      {tab === 'General' && <General server={server} reload={reload} />}
      {tab === 'Plugins' && <PluginsTab server={server} reload={reload} />}
      {tab === 'Access' && <Access server={server} />}
      {tab === 'Sessions' && <Sessions server={server} reload={reload} />}
      {tab === 'Logs' && <LogTable serverId={server.id} />}
    </>
  )
}

function General({ server, reload }: { server: Server; reload: () => Promise<void> }) {
  const nav = useNavigate()
  const pick = (s: Server) => ({ name: s.name, description: s.description, host: s.host, port: s.port, auth_mode: s.auth_mode, log_level: s.log_level, public_url: s.public_url ?? '', instructions: s.instructions })
  const [f, setF] = useState(pick(server))
  useEffect(() => setF(pick(server)), [server.id, server.auth_mode, server.log_level, server.port, server.host, server.name])
  const { run, error, busy } = useAction()
  const [saved, setSaved] = useState(false)
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v })
  const url = server.status.url ?? `http://${server.host}:${server.port}/mcp`
  const name = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const bearer = server.auth_mode === 'bearer' || server.auth_mode === 'both'
  const cli = `claude mcp add --transport http ${name} ${url}${bearer ? ' --header "Authorization: Bearer <TOKEN>"' : ''}`
  const json = JSON.stringify({ mcpServers: { [name]: { type: 'http', url, ...(bearer ? { headers: { Authorization: 'Bearer <TOKEN>' } } : {}) } } }, null, 2)
  return (
    <>
      <div className="card">
        <h2>Configuration</h2>
        {error && <Alert kind="err">{error}</Alert>}{saved && <Alert kind="ok">Saved</Alert>}
        <div className="grid2">
          <Field label="Name"><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Description"><input type="text" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Bind host"><input type="text" value={f.host} onChange={(e) => set('host', e.target.value)} /></Field>
          <Field label="Port"><input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
          <Field label="Authentication" desc="Changing host/port/auth restarts the server."><AuthSelect value={f.auth_mode} onChange={(v) => set('auth_mode', v)} /></Field>
          <Field label="Logging"><LogSelect value={f.log_level} onChange={(v) => set('log_level', v)} /></Field>
          <Field label="Public URL" desc="OAuth issuer base if behind a proxy, e.g. https://mcontrolprogram.example.com. Blank = http://host:port"><input type="text" value={f.public_url} onChange={(e) => set('public_url', e.target.value)} /></Field>
          <Field label="Instructions for agents" desc="Sent in the MCP initialize response."><textarea value={f.instructions} onChange={(e) => set('instructions', e.target.value)} /></Field>
        </div>
        <div className="row between">
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => run(async () => { await api(`/servers/${server.id}`, { method: 'PUT', body: { ...f, public_url: f.public_url || null } }); setSaved(true); setTimeout(() => setSaved(false), 1500); await reload() })}>Save</button>
            <button disabled={busy} onClick={() => run(async () => { await api(`/servers/${server.id}/restart`, { method: 'POST' }); await reload() })}>Restart</button>
            {server.status.running ? <button disabled={busy} onClick={() => run(async () => { await api(`/servers/${server.id}/stop`, { method: 'POST' }); await reload() })}>Stop</button>
              : <button disabled={busy} onClick={() => run(async () => { await api(`/servers/${server.id}/start`, { method: 'POST' }); await reload() })}>Start</button>}
          </div>
          <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete server "${server.name}" and all its plugin instances, tokens and clients?`)) void run(async () => { await api(`/servers/${server.id}`, { method: 'DELETE' }); nav('/servers') }) }}>Delete server</button>
        </div>
      </div>
      <div className="card">
        <h2>Connect an agent</h2>
        <p className="muted small">Endpoint: <code>{url}</code> <CopyButton text={url} /> — {server.auth_mode === 'none' ? 'no authentication' : server.auth_mode === 'oauth' ? 'OAuth 2.1: the client discovers the authorization server and a MControlProgram admin approves it on the consent page.' : 'create a bearer token in the Access tab and substitute it for <TOKEN>.'}</p>
        <h3>Claude Code</h3>
        <div className="row" style={{ alignItems: 'flex-start' }}><pre style={{ flex: 1 }}>{cli}</pre><CopyButton text={cli} /></div>
        <h3 style={{ marginTop: 12 }}>.mcp.json / claude_desktop_config.json</h3>
        <div className="row" style={{ alignItems: 'flex-start' }}><pre style={{ flex: 1 }}>{json}</pre><CopyButton text={json} /></div>
      </div>
    </>
  )
}

// ---------------- Plugins tab ----------------

function PluginsTab({ server, reload }: { server: Server; reload: () => Promise<void> }) {
  const [plugins] = useApi<PluginMeta[]>('/plugins')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Instance>()
  const { run, error } = useAction()
  const [actionOut, setActionOut] = useState<Record<string, unknown>>({})
  const statusOf = (i: Instance): InstanceStatus | undefined => server.status.instances.find((s) => s.id === i.id)
  return (
    <>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row between" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>Plugin instances</h2><button className="primary" onClick={() => setAdding(true)}>+ Add plugin</button></div>
      {server.instances.length === 0 && <div className="card muted">No plugins on this server. Agents connecting will see no tools.</div>}
      {server.instances.map((inst) => {
        const st = statusOf(inst); const meta = plugins?.find((p) => p.id === inst.plugin_id)
        return (
          <div className="card" key={inst.id}>
            <div className="row between">
              <div className="row">
                <strong>{inst.name}</strong><Badge kind="info">{meta?.name ?? inst.plugin_id} {meta?.version}</Badge>
                {!inst.enabled ? <Badge>disabled</Badge> : st?.error ? <Badge kind="err">error</Badge> : st ? <Badge kind="ok">active</Badge> : <Badge kind="warn">not running</Badge>}
              </div>
              <div className="row">
                <label className="toggle"><input type="checkbox" checked={inst.enabled} onChange={(e) => run(async () => { await api(`/instances/${inst.id}`, { method: 'PUT', body: { enabled: e.target.checked } }); await reload() })} /> Enabled</label>
                <button className="sm" onClick={() => setEditing(inst)}>Configure</button>
                {st && <ToolsButton inst={st} />}
                <button className="sm danger" onClick={() => { if (window.confirm(`Remove plugin instance "${inst.name}"?`)) void run(async () => { await api(`/instances/${inst.id}`, { method: 'DELETE' }); await reload() }) }}>Remove</button>
              </div>
            </div>
            {st?.error && <div className="err small" style={{ marginTop: 8 }}>{st.error}</div>}
            {st && <InstanceItems inst={st} />}
            {st?.status && <details style={{ marginTop: 10 }}><summary className="muted small">Status</summary><Json value={st.status} /></details>}
            {st?.actions && st.actions.length > 0 && (
              <div className="row" style={{ marginTop: 10 }}>
                {st.actions.map((a) => <button className="sm" key={a.key} onClick={() => run(async () => { const r = await api(`/instances/${inst.id}/actions/${a.key}`, { method: 'POST', body: {} }); setActionOut({ ...actionOut, [inst.id]: r.result }) })}>{a.title}</button>)}
              </div>
            )}
            {actionOut[inst.id] !== undefined && <Json value={actionOut[inst.id]} />}
          </div>
        )
      })}
      {adding && plugins && <AddInstance server={server} plugins={plugins} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload() }} />}
      {editing && plugins && <EditInstance inst={editing} meta={plugins.find((p) => p.id === editing.plugin_id)} tools={server.status.instances.find((i) => i.id === editing.id)?.tools} onClose={() => setEditing(undefined)} onDone={() => { setEditing(undefined); void reload() }} />}
    </>
  )
}

export function ConfigEditor({ schema, value, onChange, options }: { schema: any; value: any; onChange: (v: any) => void; options?: Record<string, any> }) {
  const [raw, setRaw] = useState(false)
  const [txt, setTxt] = useState('')
  const [bad, setBad] = useState(false)
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="sm" onClick={() => { if (!raw) setTxt(JSON.stringify(value, null, 2)); setRaw(!raw) }}>{raw ? 'Form' : 'Raw JSON'}</button>
      </div>
      {raw
        ? <><textarea style={{ minHeight: 320 }} value={txt} onChange={(e) => { setTxt(e.target.value); try { onChange(JSON.parse(e.target.value)); setBad(false) } catch { setBad(true) } }} />{bad && <div className="err small">Invalid JSON</div>}</>
        : <SchemaForm schema={schema} value={value} onChange={onChange} options={options} />}
    </>
  )
}

const APPROVAL_MODES: [ApprovalPolicy['mode'], string][] = [['none', 'Never'], ['writes', 'Tools that are not read-only'], ['all', 'Every tool'], ['list', 'Only these tools…']]
function ApprovalEditor({ value, onChange, tools }: { value: ApprovalPolicy; onChange: (p: ApprovalPolicy) => void; tools?: string[] }) {
  const sel = value.tools ?? []
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Human approval</h3>
      <Field label="Require admin approval for" desc="Gated calls wait in the Approvals page; the agent is told to check back until you decide.">
        <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as ApprovalPolicy['mode'] })}>{APPROVAL_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </Field>
      {value.mode === 'list' && (tools?.length ? <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {tools.map((t) => <label key={t} className="row small"><input type="checkbox" checked={sel.includes(t)} onChange={(e) => onChange({ ...value, tools: e.target.checked ? [...sel, t] : sel.filter((x) => x !== t) })} /> {t}</label>)}
      </div> : <p className="muted small">Tool names are known once the instance has started; save, then edit again to pick them.</p>)}
    </div>
  )
}
function AddInstance({ server, plugins, onClose, onDone }: { server: Server; plugins: PluginMeta[]; onClose: () => void; onDone: () => void }) {
  const [approval, setApproval] = useState<ApprovalPolicy>({ mode: 'none' })
  const [pid, setPid] = useState(plugins[0]?.id ?? '')
  const meta = plugins.find((p) => p.id === pid)
  const [name, setName] = useState(pid)
  const [cfg, setCfg] = useState<any>(() => ({ ...defaultsFor(meta?.configSchema), ...(meta?.defaultConfig ?? {}) }))
  const { run, error, busy } = useAction()
  const choose = (id: string) => { const m = plugins.find((p) => p.id === id); setPid(id); setName(id); setCfg({ ...defaultsFor(m?.configSchema), ...(m?.defaultConfig ?? {}) }) }
  return (
    <Modal title="Add plugin" onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="grid2">
        <Field label="Plugin"><select value={pid} onChange={(e) => choose(e.target.value)}>{plugins.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id}@{p.version})</option>)}</select></Field>
        <Field label="Instance name" desc="Tool prefix seen by agents, e.g. ssh → ssh_exec"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      {meta && <p className="muted small">{meta.description}</p>}
      {meta && <ConfigEditor schema={meta.configSchema} value={cfg} onChange={setCfg} options={meta.globalConfig} />}
      <ApprovalEditor value={approval} onChange={setApproval} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !/^[a-zA-Z0-9_-]+$/.test(name)} onClick={() => run(async () => { await api(`/servers/${server.id}/instances`, { method: 'POST', body: { plugin_id: pid, name, config: cfg, approval } }); onDone() })}>Add</button>
      </div>
    </Modal>
  )
}

function EditInstance({ inst, meta, tools, onClose, onDone }: { inst: Instance; meta?: PluginMeta; tools?: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(inst.name)
  const [approval, setApproval] = useState<ApprovalPolicy>(inst.approval ?? { mode: 'none' })
  const [cfg, setCfg] = useState<any>(inst.config)
  const { run, error, busy } = useAction()
  return (
    <Modal title={`Configure ${inst.name}`} onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <Field label="Instance name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <p className="muted small">Secrets show as •••••••• — leave them untouched to keep the stored value, or type a new one.</p>
      {meta ? <ConfigEditor schema={meta.configSchema} value={cfg} onChange={setCfg} options={meta.globalConfig} /> : <Alert kind="err">Plugin "{inst.plugin_id}" is not loaded; config cannot be edited as a form.</Alert>}
      <ApprovalEditor value={approval} onChange={setApproval} tools={tools} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !/^[a-zA-Z0-9_-]+$/.test(name)} onClick={() => run(async () => { await api(`/instances/${inst.id}`, { method: 'PUT', body: { name, config: cfg, approval } }); onDone() })}>Save & restart instance</button>
      </div>
    </Modal>
  )
}

// ---------------- Access tab ----------------

function Access({ server }: { server: Server }) {
  const [tokens, reloadTokens] = useApi<any[]>(`/servers/${server.id}/tokens`)
  const [clients, reloadClients] = useApi<any[]>(`/servers/${server.id}/oauth/clients`, 10000)
  const [issued] = useApi<any[]>(`/servers/${server.id}/oauth/tokens`, 10000)
  const [newName, setNewName] = useState('')
  const [created, setCreated] = useState<{ name: string; token: string }>()
  const { run, error, busy } = useAction()
  const oauth = server.auth_mode === 'oauth' || server.auth_mode === 'both'
  const bearer = server.auth_mode === 'bearer' || server.auth_mode === 'both'
  return (
    <>
      {error && <Alert kind="err">{error}</Alert>}
      {server.auth_mode === 'none' && <Alert kind="err">This server accepts unauthenticated connections. Anyone who can reach {server.host}:{server.port} can use its tools.</Alert>}
      <div className="card">
        <h2>Bearer tokens {!bearer && <Badge kind="warn">not accepted in {server.auth_mode} mode</Badge>}</h2>
        {created && <Alert kind="ok"><div>Token <strong>{created.name}</strong> created. Copy it now; it will not be shown again.</div><div className="row" style={{ marginTop: 6 }}><code>{created.token}</code><CopyButton text={created.token} /></div></Alert>}
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="text" placeholder="Token name, e.g. claude-code-laptop" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ maxWidth: 320 }} />
          <button className="primary" disabled={busy || !newName} onClick={() => run(async () => { const r = await api(`/servers/${server.id}/tokens`, { method: 'POST', body: { name: newName } }); setCreated({ name: newName, token: r.token }); setNewName(''); await reloadTokens() })}>Create token</button>
        </div>
        <table><thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>
          {tokens?.map((t) => <tr key={t.id}><td>{t.name}</td><td className="mono">{t.prefix}…</td><td>{fmtTime(t.created_at)}</td><td>{fmtTime(t.last_used_at)}</td><td>{t.expires_at ? fmtTime(t.expires_at) : 'never'}</td>
            <td><button className="sm danger" onClick={() => { if (window.confirm(`Revoke token "${t.name}"?`)) void run(async () => { await api(`/tokens/${t.id}`, { method: 'DELETE' }); await reloadTokens() }) }}>Revoke</button></td></tr>)}
          {tokens?.length === 0 && <tr><td colSpan={6} className="muted">No tokens.</td></tr>}
        </tbody></table>
      </div>
      <div className="card">
        <h2>OAuth 2.1 clients {!oauth && <Badge kind="warn">OAuth disabled on this server</Badge>}</h2>
        <p className="muted small">Clients register themselves dynamically at <code>{(server.status.url ?? '').replace(/\/mcp$/, '')}/register</code>. A MControlProgram admin approves each on the consent page during the first authorization.</p>
        <table><thead><tr><th>Name</th><th>Client ID</th><th>Redirect URIs</th><th>Approved</th><th>Registered</th><th></th></tr></thead><tbody>
          {clients?.map((c) => <tr key={c.client_id}><td>{c.client_name ?? <span className="muted">unnamed</span>}</td><td className="mono small">{c.client_id}</td><td className="small">{(c.redirect_uris ?? []).join(', ')}</td>
            <td><label className="toggle"><input type="checkbox" checked={c.approved} onChange={(e) => run(async () => { await api(`/oauth/clients/${c.client_id}`, { method: 'PUT', body: { approved: e.target.checked } }); await reloadClients() })} /> {c.approved ? 'yes' : 'no'}</label></td>
            <td>{fmtTime(c.created_at)}</td>
            <td><button className="sm danger" onClick={() => { if (window.confirm('Delete client and revoke its tokens?')) void run(async () => { await api(`/oauth/clients/${c.client_id}`, { method: 'DELETE' }); await reloadClients() }) }}>Delete</button></td></tr>)}
          {clients?.length === 0 && <tr><td colSpan={6} className="muted">No OAuth clients registered.</td></tr>}
        </tbody></table>
        {issued && issued.length > 0 && <details style={{ marginTop: 12 }}><summary className="muted small">Issued tokens ({issued.length})</summary>
          <table><thead><tr><th>Kind</th><th>Client</th><th>Scopes</th><th>Expires</th><th>Issued</th></tr></thead><tbody>
            {issued.map((t, i) => <tr key={i}><td>{t.kind}</td><td className="mono small">{t.client_id}</td><td>{t.scopes || '—'}</td><td>{t.expires_at ? fmtTime(t.expires_at * 1000) : 'never'}</td><td>{fmtTime(t.created_at)}</td></tr>)}
          </tbody></table></details>}
      </div>
    </>
  )
}

// ---------------- Sessions tab ----------------

function Sessions({ server, reload }: { server: Server; reload: () => Promise<void> }) {
  const { run, error } = useAction()
  return (
    <div className="card">
      {error && <Alert kind="err">{error}</Alert>}
      <h2>Active MCP sessions</h2>
      <table><thead><tr><th>Principal</th><th>Client</th><th>Session</th><th>Started</th><th>Last seen</th><th>Calls</th><th></th></tr></thead><tbody>
        {server.status.sessions.map((s) => <tr key={s.id}><td>{s.principal}</td><td>{s.client ?? '—'}</td><td className="mono small">{s.id.slice(0, 8)}…</td><td>{fmtTime(s.startedAt)}</td><td>{fmtTime(s.lastSeen)}</td><td>{s.calls}</td>
          <td><button className="sm danger" onClick={() => run(async () => { await api(`/servers/${server.id}/sessions/${s.id}`, { method: 'DELETE' }); await reload() })}>Disconnect</button></td></tr>)}
        {server.status.sessions.length === 0 && <tr><td colSpan={7} className="muted">No agents connected.</td></tr>}
      </tbody></table>
    </div>
  )
}

// Configured hosts (ssh) / upstream servers (mcp) from the instance status.
function InstanceItems({ inst }: { inst: InstanceStatus }) {
  const items: string[] = (inst.status?.hosts ?? inst.status?.servers ?? []).map((x: any) => (typeof x === 'string' ? x : x.name + (x.transport ? ` (${x.transport})` : '')))
  return items.length > 0 ? <div className="chips" style={{ marginTop: 10 }}>{items.map((n) => <span className="chip mono" key={n}>{n}</span>)}</div> : null
}

// Button + popup describing each tool.
function ToolsButton({ inst }: { inst: InstanceStatus }) {
  const [open, setOpen] = useState(false)
  const info = inst.toolInfo ?? inst.tools.map((name) => ({ name, description: '' }))
  if (info.length === 0) return null
  return (
    <>
      <button className="sm" onClick={() => setOpen(true)}>Tools ({info.length})</button>
      {open && <Modal title={`${inst.name} tools`} onClose={() => setOpen(false)}>
        {info.map((t) => <div key={t.name} style={{ marginBottom: 12 }}><div className="mono"><strong>{inst.name}_{t.name}</strong></div><div className="muted small">{t.description}</div></div>)}
      </Modal>}
    </>
  )
}
