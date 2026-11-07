import { useState } from 'react'
import { api, fmtTime, useApi, type Approval } from '../api'
import { Alert, Badge, Json, useAction } from './ui'
import { SshRuleDialog } from '../plugins/SshCommands'
import { UrlRuleDialog } from '../plugins/WebTraffic'

type RuleAction = 'allow' | 'block'
/** Asks whose rule is a single per-tool switch: set it directly, no dialog. */
const direct = (a: Approval) => a.feature === 'tool' || a.feature === 'mcp_tool'
const urlNoQuery = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname } catch { return u } }

/** Prefill for SSH's rule dialog: block the programs; allow the narrowest thing that lets this line run (written files may still need their own rule). */
function sshTarget(s: any, action: RuleAction) {
  const progs: string[] = s.programs ?? []
  if (action === 'allow' && s.single) return { action, kind: 'prefix' as const, value: s.single as string, host: s.host, command: s.command }
  return { action, kind: progs.length ? 'program' as const : 'prefix' as const, value: progs.join(' ') || s.command, host: s.host, command: s.command }
}
/** Prefill for the URL rule dialog: block the domain, allow the URL without its query. */
const urlTarget = (s: any, action: RuleAction) => action === 'block' ? { action, kind: 'domain' as const, value: s.host as string, url: s.url } : { action, kind: 'url' as const, value: urlNoQuery(s.url), url: s.url }

/**
 * Pending asks with their decisions. `plugin` limits the list to one plugin (its own page); without it, every ask (Approvals page).
 * "Add … rule" writes the rule where it lives (the plugin's rules, or the instance's tool rules), then decides the ask.
 */
export function PendingAsks({ plugin, title = 'Waiting for approval', hideEmpty }: { plugin?: string; title?: string; hideEmpty?: boolean }) {
  const [data, reload, err] = useApi<{ pending: Approval[] }>(`/approvals${plugin ? `?plugin=${plugin}` : ''}`, 3000)
  const { run, error, busy } = useAction()
  const [dialog, setDialog] = useState<{ a: Approval; action: RuleAction }>()
  const decide = (a: Approval, d: 'approved' | 'denied') => api(`/approvals/${a.id}/${d}`, { method: 'POST' })
  const once = (a: Approval, d: 'approved' | 'denied') => run(async () => { await decide(a, d); await reload() })
  const addRule = (a: Approval, action: RuleAction) => {
    if (!direct(a)) return setDialog({ a, action })
    void run(async () => {
      const rule = action === 'allow' ? 'allow' : 'deny'
      // MCP pass-through: the upstream tool's rule; core tool gate: the instance's per-tool rule
      if (a.feature === 'mcp_tool') await api(`/plugins/mcp/actions/set_tool_rule`, { method: 'POST', body: { upstream: a.subject?.upstream, tool: a.subject?.tool, action: rule } })
      else await api(`/instances/${a.instance_id}/tool-rules/${encodeURIComponent(a.subject?.tool ?? a.tool)}`, { method: 'PUT', body: { rule } })
      await decide(a, action === 'allow' ? 'approved' : 'denied'); await reload()
    })
  }
  const ruleDone = async (action: string) => {
    const a = dialog!.a; setDialog(undefined)
    await run(async () => { if (action !== 'ask') await decide(a, action === 'allow' ? 'approved' : 'denied').catch(() => {}); await reload() }) // already decided elsewhere: fine
  }
  const pending = data?.pending ?? []
  if (hideEmpty && !pending.length && !error && !err) return null
  const kind = dialog && (dialog.a.plugin_id === 'ssh' && dialog.a.feature === 'command' ? 'ssh' : dialog.a.feature === 'url' ? 'url' : undefined)

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
      {dialog && kind === 'ssh' && <SshRuleDialog init={sshTarget(dialog.a.subject ?? {}, dialog.action)} onClose={() => setDialog(undefined)} onDone={ruleDone} />}
      {dialog && kind === 'url' && <UrlRuleDialog plugin={dialog.a.plugin_id as 'web' | 'browserpaw'} init={urlTarget(dialog.a.subject ?? {}, dialog.action)} onClose={() => setDialog(undefined)} onDone={ruleDone} />}
      {dialog && !kind && <Alert kind="err">No rule editor for {dialog.a.plugin_id}/{dialog.a.feature}; use Allow once / Deny once.</Alert>}
    </div>
  )
}
