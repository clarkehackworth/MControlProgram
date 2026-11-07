import { useCallback, useEffect, useState } from 'react'
import { api, useApi, type Server } from '../api'
import { Alert, Badge, Json, useAction } from '../components/ui'
import { PendingAsks } from '../components/Asks'

type Action = 'allow' | 'ask' | 'deny'
interface Tool { upstream: string; tool: string; description: string; read_only: boolean; rule: Action | null }
interface Call { id: number; ts: number; server_id: string; instance: string; principal: string | null; upstream: string; tool: string; args: string | null; error: string | null; blocked: string | null; allowed_by: string | null; ms: number | null; now: Action }

const act = <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/mcp/actions/${key}`, { method: 'POST', body }).then((r) => r.result)
const POLICIES = [['allow', 'Allow by default', 'Agents can call any tool not set to ask or deny.'], ['ask', 'Ask by default', 'Tools without their own rule wait for your approval.'], ['deny', 'Deny by default', 'Agents can call only tools set to allow.']] as const
const ACTIONS: Action[] = ['allow', 'ask', 'deny']
const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]
const fmt = (ts: number) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString() }
const asked = (b: string | null) => !!b?.startsWith('awaiting approval')

/** MCP pass-through: per-tool allow/ask/deny across upstream servers, default policy, pending asks and the call log. */
export default function McpTools({ upstreams }: { upstreams: string[] }) {
  const [state, setState] = useState<{ policy?: Action; tools: Tool[] }>({ tools: [] }) // no policy until loaded: no radio lit
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => setState(await act('tool_rules'))), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const { policy, tools } = state
  const setRule = (t: Tool, action: Action | '') => run(async () => { await act('set_tool_rule', { upstream: t.upstream, tool: t.tool, action }); await load() })
  const setPolicy = (p: Action) => { if (window.confirm(`${POLICIES.find((x) => x[0] === p)![1]}?\n\nTools without their own rule will ${p === 'allow' ? 'run without asking' : p === 'ask' ? 'wait for your approval' : 'be refused'}.`)) void run(async () => { await act('set_policy', { policy: p }); await load() }) }
  const refresh = (name: string) => run(async () => { await act('test_server', { name }); await load() })
  const unseen = upstreams.filter((u) => !tools.some((t) => t.upstream === u))

  return (
    <>
      <PendingAsks plugin="mcp" title="Tool calls waiting for approval" hideEmpty />
      <div className="card">
        <h2 style={{ margin: 0 }}>Access rules</h2>
        {error && <Alert kind="err">{error}</Alert>}
        <div className="row" style={{ margin: '12px 0', gap: 8, alignItems: 'stretch' }} role="radiogroup" aria-label="Default policy">
          {POLICIES.map(([p, t, d]) =>
            <button key={p} role="radio" aria-checked={policy === p} className={policy === p ? 'primary' : ''} style={{ flex: 1, textAlign: 'left', padding: '8px 12px' }}
              onClick={() => policy && policy !== p && setPolicy(p)}>
              <strong>{policy === p ? '● ' : '○ '}{t}</strong><div className="small" style={{ opacity: 0.8 }}>{d}</div>
            </button>)}
        </div>
        <table>
          <thead><tr><th>Server</th><th>Tool</th><th>Description</th><th>Access</th></tr></thead>
          <tbody>
            {tools.map((t) => <tr key={`${t.upstream}/${t.tool}`}>
              <td className="small">{t.upstream}</td>
              <td className="mono">{t.tool}{t.read_only && <> <Badge>read-only</Badge></>}</td>
              <td className="muted small" style={{ width: '100%' }} title={t.description}><div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.description}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <div className="row" style={{ gap: 4 }} role="radiogroup" aria-label={`${t.tool} access`}>
                  {ACTIONS.map((a) => <button key={a} role="radio" aria-checked={t.rule === a} disabled={busy}
                    className={`sm${t.rule === a ? (a === 'deny' ? ' danger' : ' primary') : ''}`}
                    title={t.rule === a ? 'Click again to follow the default' : undefined}
                    onClick={() => void setRule(t, t.rule === a ? '' : a)}>{a}</button>)}
                  {!t.rule && <span className="muted small">default ({policy})</span>}
                </div>
              </td>
            </tr>)}
            {unseen.map((u) => <tr key={u}><td className="small">{u}</td><td colSpan={3} className="muted small">Tools not listed yet. <button className="sm" disabled={busy} onClick={() => void refresh(u)}>Fetch tools</button></td></tr>)}
            {tools.length === 0 && unseen.length === 0 && <tr><td colSpan={4} className="muted">No upstream servers configured.</td></tr>}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Applies to every MCP pass-through instance on every server, immediately (connections are kept). Tools hidden by an instance's expose/hide lists aren't offered to agents at all.
          A tool's own rule wins over the default; click its active button again to go back to the default. Asks block the agent for a short while, then it is told to check back; decide here or on the Approvals page.
          The list updates whenever an instance connects or you run <em>Test server</em>.
        </p>
      </div>
      {policy && <CallLog upstreams={upstreams} reloadKey={tools} />}
    </>
  )
}

function CallLog({ upstreams, reloadKey }: { upstreams: string[]; reloadKey: unknown }) {
  const [servers] = useApi<Server[]>('/servers')
  const [range, setRange] = useState(86400e3)
  const [f, setF] = useState({ q: '', upstream: '', outcome: '', server: '' })
  const [live, setLive] = useState(true)
  const [data, setData] = useState<{ rows: Call[]; more: boolean }>()
  const [open, setOpen] = useState<number>()
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => setData(await act('calls', { since: Date.now() - range, until: Date.now(), ...f }))), [range, f, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load()
    if (!live) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load, live])
  const sname = (id: string) => servers?.find((s) => s.id === id)?.name ?? id
  const rows = data?.rows ?? []

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Call log <span className="muted small">({rows.length}{data?.more ? '+' : ''})</span></h2>
        <div className="row">
          <label className="toggle small"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Auto-refresh</label>
          <button className="sm" onClick={load} disabled={busy}>Refresh</button>
          <button className="sm danger" onClick={() => { if (window.confirm('Delete the whole call log?')) void run(async () => { await act('clear_calls'); await load() }) }}>Clear log</button>
        </div>
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ width: 160 }}>{RANGES.map(([l, ms]) => <option key={ms} value={ms}>{l}</option>)}</select>
        <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} style={{ width: 130 }}><option value="">Allowed & blocked</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option><option value="error">Errors</option></select>
        <select value={f.upstream} onChange={(e) => setF({ ...f, upstream: e.target.value })} style={{ width: 160 }}><option value="">All upstreams</option>{upstreams.map((u) => <option key={u}>{u}</option>)}</select>
        <select value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} style={{ width: 160 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input type="text" placeholder="Search tool, arguments or agent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 240 }} />
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Time</th><th>Server / agent</th><th>Upstream</th><th>Tool</th><th>Arguments</th><th>Access</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{sname(r.server_id)}{r.instance !== 'mcp' ? `/${r.instance}` : ''}<div className="muted">{r.principal ?? '—'}</div></td>
              <td className="small">{r.upstream}</td>
              <td className="mono">{r.tool}</td>
              <td className="mono small" style={{ width: '100%', minWidth: 300, cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
                {open === r.id ? <Json value={(() => { try { return JSON.parse(r.args ?? 'null') } catch { return r.args } })()} />
                  : <div style={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.args}</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {asked(r.blocked) ? <Badge kind="warn">Asked</Badge> : r.blocked ? <Badge kind="err">Blocked</Badge> : <Badge kind="ok">Allowed</Badge>}
                <span className="muted small"> {(r.blocked ?? r.allowed_by ?? '').replace(/^awaiting approval: /, '')}</span>
                <div className="small muted">now {r.now}</div>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked ? <span className="muted small">—</span> : r.error ? <><Badge kind="err">failed</Badge> <span className="muted small" title={r.error}>{r.error.slice(0, 40)}</span></> : <span className="muted small">ok</span>}
                {r.ms != null && <span className="muted small"> {r.ms} ms</span>}
              </td>
            </tr>)}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">{data ? 'No calls in this timeframe.' : 'Loading…'}</td></tr>}
          </tbody>
        </table>
      </div>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older calls.</p>}
    </div>
  )
}
