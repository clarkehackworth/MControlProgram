import { api, fmtTime, useApi, type Approval } from '../api'
import { Alert, Badge, Json, useAction } from '../components/ui'

const KIND: Record<string, 'ok' | 'err' | 'warn' | 'info' | undefined> = { approved: 'ok', used: 'ok', denied: 'err', expired: 'warn', pending: 'info' }

export default function Approvals() {
  const [data, reload, err] = useApi<{ pending: Approval[]; recent: Approval[] }>('/approvals', 3000)
  const { run, error, busy } = useAction()
  const decide = (id: string, d: 'approved' | 'denied') => run(async () => { await api(`/approvals/${id}/${d}`, { method: 'POST' }); await reload() })
  if (err) return <Alert kind="err">{err}</Alert>
  const pending = data?.pending ?? [], recent = data?.recent ?? []
  return (
    <>
      <h1>Approvals</h1>
      {error && <Alert kind="err">{error}</Alert>}
      <p className="muted">Tool calls gated by an instance's approval policy wait here. The agent blocks briefly, then is told to check back; after the configured attempts it pauses until you decide.</p>
      <div className="card">
        <h2>Waiting ({pending.length})</h2>
        {pending.length === 0 && <p className="muted">Nothing waiting.</p>}
        {pending.map((a) => (
          <div key={a.id} className="card" style={{ marginBottom: 10 }}>
            <div className="row between">
              <div><b className="mono">{a.tool}</b> <span className="muted small">by {a.principal} · instance {a.instance_name} · {fmtTime(a.created_at)} · attempt {a.attempts} · expires {fmtTime(a.expires_at)}</span></div>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => decide(a.id, 'approved')}>Approve</button>
                <button disabled={busy} onClick={() => decide(a.id, 'denied')}>Deny</button>
              </div>
            </div>
            <Json value={a.args} />
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Recent decisions</h2>
        <table><thead><tr><th>Time</th><th>Tool</th><th>Principal</th><th>Instance</th><th>Status</th><th>By</th><th>Args</th></tr></thead><tbody>
          {recent.map((a) => <tr key={a.id}><td className="mono small">{fmtTime(a.decided_at ?? a.created_at)}</td><td className="mono">{a.tool}</td><td>{a.principal}</td><td>{a.instance_name}</td><td><Badge kind={KIND[a.status]}>{a.status}</Badge></td><td>{a.decided_by ?? ''}</td><td className="mono small" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(a.args)}</td></tr>)}
          {recent.length === 0 && <tr><td colSpan={7} className="muted">No decisions yet.</td></tr>}
        </tbody></table>
      </div>
    </>
  )
}
