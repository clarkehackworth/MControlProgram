import { useEffect, useState } from 'react'
import { Badge, api, type PluginUi } from '@mcontrolprogram/ui'
// browserpaw declares `dependencies: { web }`: its browser URL list uses web's rule engine and rules panel.
import { WebTraffic, UrlRuleDialog, urlTarget, fmt, type TrafficFlavor, type Req } from '@plugin/web'

interface Sync { inSync: boolean; ackRev: number | null; rev: number; lastPull: number | null; error: string | null; rejected: { id: number; error: string }[] }
const VIA: Record<string, string> = { dnr: 'blocked in the browser', 'nav-guard': 'blocked in the browser (scheme)', 'tool-arg': 'refused before reaching the browser', observed: 'seen in the browser', dropped: 'log gap' }
const AGENT_VIA: Record<string, string> = { tool: 'the agent drove this tab', inherited: 'tab opened from an agent tab', inferred: 'only agent active at the time (best guess)' }
const syncStatus = () => api<{ result: { profiles: Record<string, Sync> } }>('/plugins/browserpaw/actions/sync_status', { method: 'POST', body: {} }).then((r) => r.result.profiles)

/** Which browsers enforce the current list. */
function SyncStatus({ rules }: { rules: { id: number; value: string }[] }) {
  const [sync, setSync] = useState<Record<string, Sync>>({})
  useEffect(() => {
    const get = () => void syncStatus().then(setSync).catch(() => {})
    get(); const t = setInterval(get, 5000)
    return () => clearInterval(t)
  }, [])
  if (!Object.keys(sync).length) return null
  return <div className="row small" style={{ marginTop: 8, flexWrap: 'wrap' }}>
    <span className="muted">Browsers:</span>
    {Object.entries(sync).map(([n, x]) => <span key={n} title={[x.error, ...x.rejected.map((r) => `rule ${rules.find((y) => y.id === r.id)?.value ?? r.id}: ${r.error}`), x.lastPull ? `last report ${fmt(x.lastPull)}` : ''].filter(Boolean).join('\n')}>
      <Badge kind={x.error ? 'err' : x.inSync ? (x.rejected.length ? 'warn' : 'ok') : 'warn'}>{n}: {x.error ? 'error' : x.inSync ? (x.rejected.length ? `${x.rejected.length} rule(s) rejected` : 'in sync') : 'pending'}</Badge>
    </span>)}
  </div>
}

const browserFlavor: TrafficFlavor = {
  askDesc: 'URLs agents pass to browser tools wait for your approval, even if an allow rule also matches.',
  rulesNote: <p className="muted small" style={{ marginBottom: 0 }}>Separate from the Web plugin's list. Applies to every BrowserPaw profile and everything the browser loads (pages, frames, scripts, fetch/XHR, websockets), pushed to running browsers immediately. A browser that hasn't confirmed the current list gets no tool calls and blocks all traffic. <code>file:</code>, <code>chrome:</code>, <code>ftp:</code>, <code>ssh:</code> and other non-web schemes are always refused. Patterns use the browser's regex engine (no lookahead or backreferences). <strong>Ask</strong> applies to URLs agents pass to browser tools (navigate, fetch, upload…); the browser can't pause a page load, so inside the browser ask rules act as allow rules and ask by default acts as allow (links an agent clicks are not asked about).</p>,
  RulesStatus: SyncStatus,
  log: {
    filters: { profile: '', via: '' },
    Filters: ({ f, set }) => <>
      <input type="text" placeholder="Profile" value={f.profile} onChange={(e) => set('profile', e.target.value)} style={{ width: 120 }} />
      <select value={f.via} onChange={(e) => set('via', e.target.value)} style={{ width: 190 }}><option value="">All sources</option>{Object.entries(VIA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    </>,
    head: [['Profile / agent', 'Type'], []],
    useCells: () => ({
      before: (r: Req) => <>
        <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.profile}{r.tab_id != null && r.tab_id >= 0 && <span className="muted"> · tab {r.tab_id}</span>}
          <div className="muted" title={r.agent_via ? AGENT_VIA[r.agent_via] : 'no agent had used this tab (the user, or browser background traffic)'}>{r.principal ?? (r.agent_via ? '(unnamed agent)' : 'user / background')}{r.agent_via && r.agent_via !== 'tool' && <> <Badge>{r.agent_via}</Badge></>}</div></td>
        <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.type}{r.method && r.method.toUpperCase() !== 'GET' && <> <Badge kind="warn">{r.method.toUpperCase()}</Badge></>}</td>
      </>,
      after: () => null,
      access: (r: Req) => (r.via ? <div className="muted small">{VIA[r.via] ?? r.via}</div> : null),
    }),
  },
}

const ui: PluginUi = {
  Page: () => <WebTraffic plugin="browserpaw" flavor={browserFlavor} />,
  asks: {
    RuleDialog: ({ approval, action, onClose, onDone }) =>
      <UrlRuleDialog plugin="browserpaw" init={urlTarget(approval.subject ?? {}, action)} onClose={onClose} onDone={onDone} />,
  },
}
export default ui
