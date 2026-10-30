import { useEffect, useState } from 'react'
import { api, useApi } from '../api'
import { Alert, Field, Json, useAction } from '../components/ui'

export default function Settings() {
  const [sys, reload] = useApi<any>('/system')
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [g, setG] = useState({ stateIdleSec: 172800, connectionIdleSec: 3600, logRetentionDays: 30, approvalWaitSec: 30, approvalMaxAttempts: 3, approvalTtlSec: 86400 })
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
          <Field label={`Approval request lifetime (seconds) — ${hours(g.approvalTtlSec)}`} desc="Undecided requests expire after this."><input type="number" value={g.approvalTtlSec} min={60} step={3600} onChange={(e) => setG({ ...g, approvalTtlSec: Number(e.target.value) })} /></Field>
        </div>
        <button className="primary" disabled={busy} onClick={() => run(async () => { await api('/system', { method: 'PUT', body: g }); await reload(); flash('Saved') })}>Save</button>
        {sys?.globalDefaults && <button disabled={busy} style={{ marginLeft: 8 }} onClick={() => setG(sys.globalDefaults)}>Reset to defaults</button>}
      </div>
      <div className="card"><h2>System</h2>{sys && <Json value={sys} />}</div>
    </>
  )
}
