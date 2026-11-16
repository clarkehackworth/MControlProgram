import { useEffect, useState } from 'react'
import { api, fmtTime, useApi } from '../api'
import { Alert, CopyButton, Field, Json, LoadingRow, useAction } from '../components/ui'

export default function Settings() {
  const [sys, reload] = useApi<any>('/system')
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [g, setG] = useState({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30, approvalWaitSec: 30, approvalMaxAttempts: 3, approvalTtlSec: 86400, approvalChannel: 'ui', approvalClientWaitSec: 240 })
  const [ok, setOk] = useState<string>()
  const { run, error, busy } = useAction()
  useEffect(() => { if (sys?.global) setG(sys.global) }, [sys])
  const hours = (sec: number) => (sec >= 86400 ? `${(sec / 86400).toFixed(1)} days` : `${(sec / 3600).toFixed(1)} h`)
  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(undefined), 2000) }
  return (
    <>
      <h1>Settings</h1>
      {error && <Alert kind="err">{error}</Alert>}{ok && <Alert kind="ok">{ok}</Alert>}
      <div className="card">
        <h2>Change admin password</h2>
        <div className="grid2">
          <Field label="Current password"><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
          <div />
          <Field label="New password (min 8)"><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="Confirm"><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        <button className="primary" disabled={busy || pw.next.length < 8 || pw.next !== pw.confirm} onClick={() => run(async () => { await api('/auth/password', { method: 'POST', body: { current: pw.current, next: pw.next } }); setPw({ current: '', next: '', confirm: '' }); flash('Password changed') })}>Change password</button>
      </div>
      <div className="card">
        <h2>Global defaults</h2>
        <p className="muted">Plugins inherit these unless an instance sets its own value. Changes apply live.</p>
        <div className="grid2">
          <Field label={`Agent state idle timeout (seconds) — ${hours(g.stateIdleSec)}`} desc="Shells, cookie jars and similar per-agent state with no activity for this long are discarded.">
            <input type="number" value={g.stateIdleSec} min={60} step={3600} onChange={(e) => setG({ ...g, stateIdleSec: Number(e.target.value) })} /></Field>
          <Field label={`Connection idle timeout (seconds) — ${hours(g.connectionIdleSec)}`} desc="Idle sockets (e.g. SSH) are closed after this long; they reopen on the next call without losing state.">
            <input type="number" value={g.connectionIdleSec} min={10} step={600} onChange={(e) => setG({ ...g, connectionIdleSec: Number(e.target.value) })} /></Field>
          <Field label="Log retention (days)" desc="Older entries are pruned hourly."><input type="number" value={g.logRetentionDays} min={1} onChange={(e) => setG({ ...g, logRetentionDays: Number(e.target.value) })} /></Field>
          <div />
          <Field label="Approval wait (seconds)" desc="A gated tool call blocks this long for a decision before telling the agent to check back later."><input type="number" value={g.approvalWaitSec} min={1} max={600} onChange={(e) => setG({ ...g, approvalWaitSec: Number(e.target.value) })} /></Field>
          <Field label="Approval max attempts" desc="After this many unanswered check-backs the agent is told to pause and stop retrying."><input type="number" value={g.approvalMaxAttempts} min={1} onChange={(e) => setG({ ...g, approvalMaxAttempts: Number(e.target.value) })} /></Field>
          <Field label="Approval channel" desc="Where asks can be answered besides the Approvals page. Client: the agent's own MCP client prompts its user (MCP elicitation, e.g. Hermes approval prompts); only for clients running outside the agent's sandbox, since the client answers for itself. API keys: external apps holding a key with the approvals permission (e.g. Control Tower in Hermes Desktop).">
            <select value={g.approvalChannel} onChange={(e) => setG({ ...g, approvalChannel: e.target.value })}>
              <option value="ui">MControlProgram only</option>
              <option value="client">MCP client prompt (elicitation)</option>
              <option value="api">API keys (external apps)</option>
            </select></Field>
          {g.approvalChannel === 'client'
            ? <Field label="Client prompt wait (seconds)" desc="How long a call waits on the client's prompt. Keep it under the client's tool timeout (Hermes: 300)."><input type="number" value={g.approvalClientWaitSec} min={5} max={3600} onChange={(e) => setG({ ...g, approvalClientWaitSec: Number(e.target.value) })} /></Field>
            : <div />}
          <Field label={`Approval request lifetime (seconds) — ${hours(g.approvalTtlSec)}`} desc="Undecided requests expire after this; an approval stays usable this long after it is given."><input type="number" value={g.approvalTtlSec} min={60} step={3600} onChange={(e) => setG({ ...g, approvalTtlSec: Number(e.target.value) })} /></Field>
        </div>
        <button className="primary" disabled={busy} onClick={() => run(async () => { await api('/system', { method: 'PUT', body: g }); await reload(); flash('Saved') })}>Save</button>
        {sys?.globalDefaults && <button disabled={busy} style={{ marginLeft: 8 }} onClick={() => setG(sys.globalDefaults)}>Reset to defaults</button>}
      </div>
      <ApiKeys channel={sys?.global?.approvalChannel} />
      <div className="card"><h2>System</h2>{sys && <Json value={sys} />}</div>
    </>
  )
}

const PERMISSION_INFO: Record<string, string> = { approvals: 'list pending approvals and allow / deny them (needs Approval channel: API keys)' }

/** Keys for external apps on /api/v1, e.g. Control Tower in Hermes Desktop. */
function ApiKeys({ channel }: { channel?: string }) {
  const [data, reload] = useApi<{ keys: any[]; permissions: string[] }>('/api-keys')
  const [name, setName] = useState('')
  const [perms, setPerms] = useState<string[]>(['approvals'])
  const [created, setCreated] = useState<{ name: string; key: string }>()
  const { run, error, busy } = useAction()
  const toggle = (list: string[], p: string) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p])
  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="muted">For external apps such as Control Tower (Hermes Desktop). They call <code>{window.location.origin}/api/v1</code> with <code>Authorization: Bearer mcpk_…</code> and can only do what their permissions allow; they never reach MCP tools.</p>
      {error && <Alert kind="err">{error}</Alert>}
      {perms.includes('approvals') && channel && channel !== 'api' && <Alert kind="err">Approval channel is not "API keys", so the approvals permission does nothing until you change it above.</Alert>}
      {created && <Alert kind="ok"><div>Key <strong>{created.name}</strong> created. Copy it now; it will not be shown again.</div><div className="row" style={{ marginTop: 6 }}><code>{created.key}</code><CopyButton text={created.key} /></div></Alert>}
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="text" placeholder="Key name, e.g. hermes-desktop" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        {data?.permissions.map((p) => <label key={p} title={PERMISSION_INFO[p]}><input type="checkbox" checked={perms.includes(p)} onChange={() => setPerms(toggle(perms, p))} /> {p}</label>)}
        <button className="primary" disabled={busy || !name} onClick={() => run(async () => { const r = await api('/api-keys', { method: 'POST', body: { name, permissions: perms } }); setCreated({ name, key: r.key }); setName(''); await reload() })}>Create key</button>
      </div>
      <table><thead><tr><th>Name</th><th>Prefix</th><th>Permissions</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
        {data?.keys.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono">{k.prefix}…</td>
          <td>{data.permissions.map((p) => <label key={p} title={PERMISSION_INFO[p]}><input type="checkbox" checked={k.permissions.includes(p)} disabled={busy} onChange={() => run(async () => { await api(`/api-keys/${k.id}`, { method: 'PUT', body: { permissions: toggle(k.permissions, p) } }); await reload() })} /> {p}</label>)}</td>
          <td>{fmtTime(k.created_at)}</td><td>{fmtTime(k.last_used_at)}</td>
          <td><button className="sm danger" onClick={() => { if (window.confirm(`Revoke API key "${k.name}"?`)) void run(async () => { await api(`/api-keys/${k.id}`, { method: 'DELETE' }); await reload() }) }}>Revoke</button></td></tr>)}
        {!data && <LoadingRow cols={6} />}
        {data?.keys.length === 0 && <tr><td colSpan={6} className="muted">No API keys.</td></tr>}
      </tbody></table>
    </div>
  )
}
