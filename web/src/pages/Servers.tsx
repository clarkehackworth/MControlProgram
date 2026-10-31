import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useApi, type Server } from '../api'
import { Alert, Badge, Field, Modal, useAction } from '../components/ui'

export default function Servers() {
  const [servers, reload, err] = useApi<Server[]>('/servers', 5000)
  const [creating, setCreating] = useState(false)
  const { run, error } = useAction()
  const act = (id: string, a: string) => run(async () => { await api(`/servers/${id}/${a}`, { method: 'POST' }); await reload() })
  return (
    <>
      <div className="row between" style={{ marginBottom: 16 }}><h1 style={{ margin: 0 }}>MCP Servers</h1><button className="primary" onClick={() => setCreating(true)}>+ New server</button></div>
      {(err || error) && <Alert kind="err">{err || error}</Alert>}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Endpoint</th><th>Auth</th><th>Logging</th><th>Status</th><th>Sessions</th><th>Plugins</th><th></th></tr></thead>
          <tbody>
            {servers?.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="muted small">{s.description}</div></td>
                <td className="mono small">{s.host}:{s.port}</td>
                <td><Badge kind="info">{s.auth_mode}</Badge></td>
                <td><Badge>{s.log_level}</Badge></td>
                <td>{s.status.running ? <Badge kind="ok">running</Badge> : s.status.error ? <Badge kind="err" >error</Badge> : <Badge>stopped</Badge>}
                  {s.status.error && <div className="err small">{s.status.error}</div>}</td>
                <td>{s.status.sessions?.length ?? 0}</td>
                <td className="small">{s.instances.map((i) => i.name).join(', ') || <span className="muted">none</span>}</td>
                <td className="row">
                  {s.status.running ? <button className="sm" onClick={() => act(s.id, 'stop')}>Stop</button> : <button className="sm" onClick={() => act(s.id, 'start')}>Start</button>}
                  <Link to={`/servers/${s.id}`}><button className="sm">Edit</button></Link>
                  <button className="sm danger" onClick={() => { if (window.confirm(`Delete server "${s.name}" and all its plugin instances, tokens and clients?`)) void run(async () => { await api(`/servers/${s.id}`, { method: 'DELETE' }); await reload() }) }}>Delete</button>
                </td>
              </tr>
            ))}
            {servers && servers.length === 0 && <tr><td colSpan={8} className="muted">No servers yet. Create one to expose plugins to agents.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <CreateServer taken={(servers ?? []).map((x) => x.port)} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void reload() }} />}
    </>
  )
}

function CreateServer({ taken, onClose, onCreated }: { taken: number[]; onClose: () => void; onCreated: () => void }) {
  let port = 7801
  while (taken.includes(port)) port++
  const [f, setF] = useState({ name: '', description: '', host: '127.0.0.1', port, auth_mode: 'bearer', log_level: 'tools' })
  const { run, error, busy } = useAction()
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v })
  return (
    <Modal title="New MCP server" onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="grid2">
        <Field label="Name"><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Description"><input type="text" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Bind host" desc="127.0.0.1 = local only; 0.0.0.0 = all interfaces / for docker"><input type="text" value={f.host} onChange={(e) => set('host', e.target.value)} /></Field>
        <Field label="Port"><input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
        <Field label="Authentication"><AuthSelect value={f.auth_mode} onChange={(v) => set('auth_mode', v)} /></Field>
        <Field label="Logging"><LogSelect value={f.log_level} onChange={(v) => set('log_level', v)} /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !f.name} onClick={() => run(async () => { await api('/servers', { method: 'POST', body: f }); onCreated() })}>Create</button>
      </div>
    </Modal>
  )
}

export function AuthSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="bearer">Bearer tokens</option><option value="oauth">OAuth 2.1</option><option value="both">Bearer + OAuth 2.1</option><option value="none">None (unauthenticated)</option>
  </select>
}
export function LogSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="off">Off</option><option value="connections">Connections only</option><option value="tools">Connections + tool calls</option><option value="full">Full (args + results)</option>
  </select>
}
