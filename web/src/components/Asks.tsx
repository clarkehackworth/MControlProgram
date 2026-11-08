import { useEffect, useState } from 'react'
import { api, fmtTime, useApi, type Approval } from '../api'
import { Alert, Badge, Json, useAction } from './ui'
import { loadPluginUi, type PluginUi } from '../plugin-ui'

type RuleAction = 'allow' | 'block'

/**
 * Pending asks with their decisions. `plugin` limits the list to one plugin (its own page); without it, every ask (Approvals page).
 * "Add … rule" writes the rule where it lives (the plugin's rules, or the instance's tool rules), then decides the ask.
 */
export function PendingAsks({ plugin, title = 'Waiting for approval', hideEmpty, onChange }: { plugin?: string; title?: string; hideEmpty?: boolean; onChange?: () => void }) {
  const [data, reload, err] = useApi<{ pending: Approval[] }>(`/approvals${plugin ? `?plugin=${plugin}` : ''}`, 3000)
  const { run, error, busy } = useAction()
  const [dialog, setDialog] = useState<{ a: Approval; action: RuleAction }>()
  const decide = (a: Approval, d: 'approved' | 'denied') => api(`/approvals/${a.id}/${d}`, { method: 'POST' })
  const once = (a: Approval, d: 'approved' | 'denied') => run(async () => { await decide(a, d); await reload() })
  const addRule = (a: Approval, action: RuleAction) => {
    if (!direct(a)) return setDialog({ a, action })
    void run(async () => {
      const rule = action === 'allow' ? 'allow' : 'deny'
      // the plugin's own rule if it has one; core tool gate: the instance's per-tool rule
      const set = asksOf(a)?.setRule
      if (set) await set(a, rule)
      else await api(`/instances/${a.instance_id}/tool-rules/${encodeURIComponent(a.subject?.tool ?? a.tool)}`, { method: 'PUT', body: { rule } })
      await decide(a, action === 'allow' ? 'approved' : 'denied'); await reload(); onChange?.()
    })
  }
  const ruleDone = async (action: string) => {
    const a = dialog!.a; setDialog(undefined)
    await run(async () => { if (action !== 'ask') await decide(a, action === 'allow' ? 'approved' : 'denied').catch(() => {}); await reload() }) // already decided elsewhere: fine
  }
  const pending = data?.pending ?? []
  // Rule editors come from each plugin's UI; the core tool gate (feature 'tool') is handled here.
  const [uis, setUis] = useState<Record<string, PluginUi>>({})
  const ids = [...new Set(pending.map((a) => a.plugin_id).filter(Boolean))].join(',')
  useEffect(() => { for (const id of ids.split(',').filter(Boolean)) void loadPluginUi(id).then((u) => setUis((x) => (x[id] ? x : { ...x, [id]: u }))) }, [ids])
  const asksOf = (a: Approval) => (a.feature === 'tool' ? undefined : uis[a.plugin_id]?.asks)
  /** Asks whose rule is a single switch: set it directly, no dialog. */
  const direct = (a: Approval) => a.feature === 'tool' || !!asksOf(a)?.direct?.(a)
  if (hideEmpty && !pending.length && !error && !err) return null
  const Dialog = dialog && asksOf(dialog.a)?.RuleDialog

  return (
    <div className="card" style={pending.length ? { borderColor: 'var(--warn)' } : undefined}>
      <h2 style={{ marginTop: 0 }}>{title} ({pending.length})</h2>
      {(error || err) && <Alert kind="err">{error ?? err}</Alert>}
      {pending.length === 0 && <p className="muted">Nothing waiting.</p>}
      {pending.map((a) => (
        <div key={a.id} className="card" style={{ marginBottom: 10 }}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div><Badge kind="info">{a.plugin_id || 'tool'}{a.feature !== 'tool' ? ` · ${a.feature}` : ''}</Badge> <b className="mono" style={{ overflowWrap: 'anywhere' }}>{a.summary || a.tool}</b></div>
              <div className="muted small">{a.reason && <>{a.reason} · </>}{a.tool} by {a.principal} · instance {a.instance_name} · {fmtTime(a.created_at)} · attempt {a.attempts} · expires {fmtTime(a.expires_at)}</div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="primary sm" disabled={busy} onClick={() => once(a, 'approved')} title="Run this one call">Allow once</button>
              <button className="sm" disabled={busy} onClick={() => addRule(a, 'allow')} title={direct(a) ? `Always allow ${a.summary || a.tool}` : 'Add an allow rule, then allow this call'}>{direct(a) ? 'Enable tool' : 'Add allow rule…'}</button>
              <button className="sm danger" disabled={busy} onClick={() => addRule(a, 'block')} title={direct(a) ? `Disable ${a.summary || a.tool}` : 'Add a block rule, then deny this call'}>{direct(a) ? 'Disable tool' : 'Add block rule…'}</button>
              <button className="sm" disabled={busy} onClick={() => once(a, 'denied')} title="Refuse this one call">Deny once</button>
            </div>
          </div>
          <details><summary className="small muted">Arguments</summary><Json value={a.args} /></details>
        </div>
      ))}
      {dialog && Dialog && <Dialog approval={dialog.a} action={dialog.action} onClose={() => setDialog(undefined)} onDone={ruleDone} />}
      {dialog && !Dialog && <Alert kind="err">No rule editor for {dialog.a.plugin_id}/{dialog.a.feature}; use Allow once / Deny once.</Alert>}
    </div>
  )
}
