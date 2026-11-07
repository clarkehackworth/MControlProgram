import { api, fmtTime, useApi, type Approval } from '../api'
import { Alert, Badge, useAction } from '../components/ui'
import { PendingAsks } from '../components/Asks'

const KIND: Record<string, 'ok' | 'err' | 'warn' | 'info' | undefined> = { approved: 'ok', used: 'ok', denied: 'err', expired: 'warn', pending: 'info' }

/** Every ask from every plugin and the core tool gate. Each plugin's page shows its own asks too. */
export default function Approvals() {
  const [data, reload, err] = useApi<{ recent: Approval[] }>('/approvals', 5000)
  const { run, error, busy } = useAction()
  const undo = (a: Approval) => run(async () => { await api(`/approvals/${a.id}/reopen`, { method: 'POST' }); await reload() })
  const recent = data?.recent ?? []
  return (
    <>
      <h1>Approvals</h1>
      {(err || error) && <Alert kind="err">{err ?? error}</Alert>}
      <p className="muted">Calls that need a human wait here: tools an instance's tool rules mark <em>ask</em>, and commands / URLs that a plugin's ask rules (or <em>ask by default</em>) catch. The agent blocks briefly, then is told to check back; after the configured attempts it pauses until you decide. <b>Add allow / block rule</b> saves a rule so you aren't asked again, then decides this call.</p>
      <PendingAsks />
      <div className="card">
        <h2>Recent decisions</h2>
        <table><thead><tr><th>Time</th><th>What</th><th>Principal</th><th>Instance</th><th>Status</th><th>By</th><th></th></tr></thead><tbody>
          {recent.map((a) => <tr key={a.id}><td className="mono small">{fmtTime(a.decided_at ?? a.created_at)}</td>
            <td><Badge>{a.plugin_id || 'tool'}{a.feature !== 'tool' ? ` · ${a.feature}` : ''}</Badge> <span className="mono small" style={{ overflowWrap: 'anywhere' }} title={JSON.stringify(a.args)}>{a.summary || a.tool}</span></td>
            <td>{a.principal}</td><td>{a.instance_name}</td><td><Badge kind={KIND[a.status]}>{a.status}</Badge></td><td>{a.decided_by ?? ''}</td>
            <td>{a.status === 'denied' && a.expires_at > Date.now() && <button className="sm" disabled={busy} onClick={() => undo(a)}
              title="Put this request back in the queue so you can decide again. The agent's next identical call checks back instead of being refused. A block rule you added stays: remove it on the plugin's page.">Undo</button>}</td></tr>)}
          {recent.length === 0 && <tr><td colSpan={7} className="muted">No decisions yet.</td></tr>}
        </tbody></table>
      </div>
    </>
  )
}
