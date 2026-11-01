import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, useApi, type Server } from '../api'
import { Alert, Badge, Field, Modal, useAction } from '../components/ui'

type Kind = 'domain' | 'url' | 'regex'
interface Block { id: number; kind: Kind; value: string; note: string; created_at: number }
interface Req { id: number; ts: number; server_id: string; instance: string; principal: string | null; method: string; url: string; host: string; status: number | null; error: string | null; blocked: string | null; ms: number | null }

const act = <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/web/actions/${key}`, { method: 'POST', body }).then((r) => r.result)

const KINDS: { kind: Kind; title: string; help: string; placeholder: string }[] = [
  { kind: 'domain', title: 'Domains', help: 'Blocks the domain and all its subdomains.', placeholder: 'example.com' },
  { kind: 'url', title: 'URLs', help: 'Blocks every URL that starts with this.', placeholder: 'https://example.com/admin/' },
  { kind: 'regex', title: 'Patterns (regex)', help: 'Case-insensitive regular expression tested against the full URL.', placeholder: '\\.(exe|zip)$' },
]

const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]

/** Mirror of the server's blockedBy() so the dialog can preview matches and the log can mark already-blocked rows. */
function matches(b: Pick<Block, 'kind' | 'value'>, url: string, host: string) {
  if (b.kind === 'domain') { const d = b.value.toLowerCase().replace(/^\*?\./, ''); return !!d && (host === d || host.endsWith('.' + d)) }
  if (b.kind === 'url') return !!b.value && url.startsWith(b.value)
  try { return !!b.value && new RegExp(b.value, 'i').test(url) } catch { return false }
}

const fmt = (ts: number) => {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
}
const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)

/** Web plugin: admin blocks (domain / URL prefix / regex) and the log of requests agents made. */
export default function WebTraffic() {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [dialog, setDialog] = useState<{ kind: Kind; value: string }>()
  const { run, error } = useAction()
  const loadBlocks = useCallback(() => run(async () => setBlocks(await act<Block[]>('blocks'))), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadBlocks() }, [loadBlocks])
  const unblock = (b: Block) => { if (window.confirm(`Unblock ${b.kind} "${b.value}"? Agents will be able to reach it again.`)) void run(async () => { await act('unblock', { id: b.id }); await loadBlocks() }) }

  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Blocked <span className="muted small">({blocks.length})</span></h2>
          <div className="row">{KINDS.map((k) => <button key={k.kind} className="sm" onClick={() => setDialog({ kind: k.kind, value: '' })}>+ Block {k.kind === 'regex' ? 'pattern' : k.kind}</button>)}</div>
        </div>
        <p className="muted small">Applies to every Web instance on every server, immediately (no restart, cookie jars are kept). Checked before each instance's own allow/deny lists, including on redirects.</p>
        {error && <Alert kind="err">{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          {KINDS.map((k) => {
            const list = blocks.filter((b) => b.kind === k.kind)
            return <div key={k.kind}>
              <strong className="small">{k.title}</strong> <span className="muted small">— {k.help}</span>
              <div className="chips" style={{ marginTop: 6 }}>
                {list.map((b) => <span key={b.id} className="chip mono" title={`${b.note ? b.note + ' — ' : ''}added ${new Date(b.created_at).toLocaleString()}`}>
                  {b.value}<button title="Unblock" aria-label={`Unblock ${b.value}`} onClick={() => unblock(b)}>✕</button>
                </span>)}
                {list.length === 0 && <span className="muted small">None</span>}
              </div>
            </div>
          })}
        </div>
      </div>
      <RequestLog blocks={blocks} onBlock={(kind, value) => setDialog({ kind, value })} />
      {dialog && <BlockDialog init={dialog} onClose={() => setDialog(undefined)} onDone={async () => { setDialog(undefined); await loadBlocks() }} />}
    </>
  )
}

function BlockDialog({ init, onClose, onDone }: { init: { kind: Kind; value: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState(init.kind)
  const [value, setValue] = useState(init.value)
  const [note, setNote] = useState('')
  const [recent, setRecent] = useState<Req[]>([])
  const { run, busy, error } = useAction()
  useEffect(() => { void act<{ rows: Req[] }>('requests', { since: Date.now() - 7 * 86400e3, limit: 2000 }).then((r) => setRecent(r.rows)).catch(() => {}) }, [])
  const k = KINDS.find((x) => x.kind === kind)!
  const regexErr = kind === 'regex' && value ? (() => { try { new RegExp(value); return undefined } catch (e) { return (e as Error).message } })() : undefined
  const hits = useMemo(() => value.trim() ? recent.filter((r) => matches({ kind, value: value.trim() }, r.url, r.host)) : [], [recent, kind, value])
  // Quick picks: the host and each parent domain (a.b.example.com → b.example.com, example.com)
  const domainPicks = kind === 'domain' && init.value ? init.value.split('.').map((_, i, a) => a.slice(i).join('.')).filter((d) => d.includes('.')) : []
  return (
    <Modal title="Add block" onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <Field label="Block by">
        <div className="row">{KINDS.map((x) => <label key={x.kind} className="toggle"><input type="radio" name="kind" checked={kind === x.kind} onChange={() => setKind(x.kind)} /> {x.kind === 'regex' ? 'Pattern (regex)' : x.kind === 'url' ? 'URL prefix' : 'Domain'}</label>)}</div>
      </Field>
      <Field label={kind === 'regex' ? 'Pattern' : kind === 'url' ? 'URL' : 'Domain'} desc={k.help}>
        <input type="text" className="mono" autoFocus placeholder={k.placeholder} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: '100%' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && !regexErr) document.getElementById('block-save')?.click() }} />
        {domainPicks.length > 1 && <div className="chips" style={{ marginTop: 6 }}>{domainPicks.map((d) => <button key={d} className={`sm${d === value ? ' primary' : ''}`} onClick={() => setValue(d)}>{d}</button>)}</div>}
        {regexErr && <div className="err small" style={{ marginTop: 4 }}>{regexErr}</div>}
      </Field>
      <Field label="Note (optional)"><input type="text" placeholder="Why is this blocked?" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} /></Field>
      {value.trim() && !regexErr && <p className="small">
        {hits.length ? <>Would have blocked <strong>{hits.length}</strong> of {recent.length} requests in the last 7 days, e.g. <span className="mono">{hits[0]!.url}</span></> : <span className="muted">Matches none of the {recent.length} requests in the last 7 days.</span>}
      </p>}
      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button id="block-save" className="danger" disabled={busy || !value.trim() || !!regexErr} onClick={() => run(async () => { await act('block', { kind, value, note }); await onDone() })}>Block</button>
      </div>
    </Modal>
  )
}

function RequestLog({ blocks, onBlock }: { blocks: Block[]; onBlock: (kind: Kind, value: string) => void }) {
  const [servers] = useApi<Server[]>('/servers')
  const [range, setRange] = useState<number | 'custom'>(86400e3)
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 86400e3))
  const [to, setTo] = useState(() => toLocalInput(Date.now()))
  const [f, setF] = useState({ q: '', method: '', outcome: '', server: '' })
  const [live, setLive] = useState(true)
  const [data, setData] = useState<{ rows: Req[]; more: boolean }>()
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    const [since, until] = range === 'custom' ? [new Date(from).getTime(), new Date(to).getTime()] : [Date.now() - range, Date.now()]
    setData(await act('requests', { since, until, ...f }))
  }), [range, from, to, f]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load()
    if (!live || range === 'custom') return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load, live, range])
  const sname = (id: string) => servers?.find((s) => s.id === id)?.name ?? id
  const rows = data?.rows ?? []
  const urlNoQuery = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname } catch { return u } }

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Request log <span className="muted small">({rows.length}{data?.more ? '+' : ''})</span></h2>
        <div className="row">
          {range !== 'custom' && <label className="toggle small"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Auto-refresh</label>}
          <button className="sm" onClick={load} disabled={busy}>Refresh</button>
          <button className="sm danger" onClick={() => { if (window.confirm('Delete the whole request log?')) void run(async () => { await act('clear_requests'); await load() }) }}>Clear log</button>
        </div>
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        <select value={String(range)} onChange={(e) => setRange(e.target.value === 'custom' ? 'custom' : Number(e.target.value))} style={{ width: 160 }}>
          {RANGES.map(([l, ms]) => <option key={ms} value={ms}>{l}</option>)}<option value="custom">Custom range…</option>
        </select>
        {range === 'custom' && <><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /> <span className="muted">to</span> <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></>}
        <select value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} style={{ width: 160 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} style={{ width: 120 }}><option value="">All methods</option>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}</select>
        <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} style={{ width: 130 }}><option value="">All outcomes</option><option value="ok">Success</option><option value="error">Errors</option><option value="blocked">Blocked</option></select>
        <input type="text" placeholder="Search URL or agent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 220 }} />
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <table>
        <thead><tr><th>Time</th><th>Server</th><th>Agent</th><th>Method</th><th>URL</th><th>Result</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const by = blocks.find((b) => matches(b, r.url, r.host))
            return <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              <td className="small">{sname(r.server_id)}{r.instance !== 'web' ? `/${r.instance}` : ''}</td>
              <td className="small muted">{r.principal ?? '—'}</td>
              <td><Badge kind={r.method === 'GET' || r.method === 'HEAD' ? undefined : 'warn'}>{r.method}</Badge></td>
              <td className="mono" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>{r.url}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked ? <Badge kind="err">blocked</Badge> : r.error ? <Badge kind="err" >failed</Badge> : <Badge kind={r.status! >= 400 ? 'err' : r.status! >= 300 ? 'info' : 'ok'}>{r.status}</Badge>}
                <span className="muted small" title={r.blocked ?? r.error ?? ''}> {r.blocked ?? r.error ?? (r.ms != null ? `${r.ms} ms` : '')}</span>
              </td>
              <td><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {by ? <span className="muted small" title={`Blocked by ${by.kind}: ${by.value}`}>🚫 blocked now</span> : <>
                  <button className="sm" title={`Block ${r.host} and its subdomains`} onClick={() => onBlock('domain', r.host)}>Block domain</button>
                  <button className="sm" title={`Block URLs starting with ${urlNoQuery(r.url)}`} onClick={() => onBlock('url', urlNoQuery(r.url))}>Block URL</button>
                </>}
              </div></td>
            </tr>
          })}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">{data ? 'No requests in this timeframe.' : 'Loading…'}</td></tr>}
        </tbody>
      </table>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older requests.</p>}
    </div>
  )
}
