import { useEffect, useState } from 'react'
import { api, useApi, type LogRow, type Server } from '../api'
import { Alert, Badge, LoadingRow, useAction } from '../components/ui'

const LEVELS = ['', 'debug', 'info', 'warn', 'error']
const CATS = ['', 'system', 'server', 'auth', 'connection', 'tool', 'approval', 'plugin']

export default function Logs() {
  return <><h1>Logs</h1><LogTable /></>
}

export function LogTable({ serverId }: { serverId?: string }) {
  const [servers] = useApi<Server[]>(serverId ? null : '/servers')
  const [f, setF] = useState({ server: serverId ?? '', category: '', level: '', q: '' })
  const [rows, setRows] = useState<LogRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState(true)
  const [more, setMore] = useState(true)
  const { run, error, busy } = useAction()
  const qs = (before?: number) => {
    const p = new URLSearchParams()
    if (f.server) p.set('server', f.server); if (f.category) p.set('category', f.category); if (f.level) p.set('level', f.level); if (f.q) p.set('q', f.q)
    if (before) p.set('before', String(before)); p.set('limit', '100')
    return p.toString()
  }
  const load = () => run(async () => { const r = await api<LogRow[]>(`/logs?${qs()}`); setRows(r); setMore(r.length === 100); setLoaded(true) })
  const loadMore = () => run(async () => { const r = await api<LogRow[]>(`/logs?${qs(rows[rows.length - 1]?.id)}`); setRows([...rows, ...r]); setMore(r.length === 100) })
  useEffect(() => { void load() }, [f.server, f.category, f.level, f.q]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live) return
    const es = new EventSource(`/api/logs/stream${f.server ? `?server=${f.server}` : ''}`, { withCredentials: true })
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as LogRow & { data?: unknown }
      if (f.category && e.category !== f.category) return; if (f.level && e.level !== f.level) return
      if (f.q && !e.message.toLowerCase().includes(f.q.toLowerCase())) return
      setRows((r) => [{ ...e, id: (r[0]?.id ?? 0) + 0.5, data: e.data !== undefined ? JSON.stringify(e.data) : null, server_id: (e as any).serverId, session_id: (e as any).sessionId }, ...r].slice(0, 500))
    }
    return () => es.close()
  }, [live, f.server, f.category, f.level, f.q])
  const sname = (id?: string) => servers?.find((s) => s.id === id)?.name ?? id?.slice(0, 8)
  return (
    <div className="card">
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row" style={{ marginBottom: 12 }}>
        {!serverId && <select value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} style={{ width: 180 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ width: 150 }}>{CATS.map((c) => <option key={c} value={c}>{c || 'All categories'}</option>)}</select>
        <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} style={{ width: 120 }}>{LEVELS.map((c) => <option key={c} value={c}>{c || 'All levels'}</option>)}</select>
        <input type="text" placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 220 }} />
        <label className="toggle"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live</label>
        <button className="sm" onClick={load} disabled={busy}>Refresh</button>
        <button className="sm danger" onClick={() => { if (window.confirm('Clear these logs?')) void run(async () => { await api(`/logs${f.server ? `?server=${f.server}` : ''}`, { method: 'DELETE' }); setRows([]) }) }}>Clear</button>
      </div>
      <table><thead><tr><th>Time</th><th>Level</th><th>Category</th>{!serverId && <th>Server</th>}<th>Message</th></tr></thead><tbody>
        {rows.map((r) => <Row key={r.id} r={r} server={serverId ? undefined : sname(r.server_id)} />)}
        {rows.length === 0 && (loaded || error ? <tr><td colSpan={5} className="muted">No log entries.</td></tr> : <LoadingRow cols={5} />)}
      </tbody></table>
      {more && rows.length > 0 && <div style={{ marginTop: 10 }}><button className="sm" onClick={loadMore} disabled={busy}>Load older</button></div>}
    </div>
  )
}

function Row({ r, server }: { r: LogRow; server?: string }) {
  const [open, setOpen] = useState(false)
  const kind = r.level === 'error' ? 'err' : r.level === 'warn' ? 'warn' : r.level === 'debug' ? undefined : 'info'
  let data: unknown
  if (open && r.data) { try { data = JSON.parse(r.data) } catch { data = r.data } }
  return (
    <>
      <tr className="log-row" onClick={() => r.data && setOpen(!open)} style={{ cursor: r.data ? 'pointer' : undefined }}>
        <td className="ts">{new Date(r.ts).toLocaleTimeString()}</td><td className="lvl"><Badge kind={kind}>{r.level}</Badge></td><td className="muted">{r.category}</td>
        {server !== undefined && <td className="small">{server}</td>}
        <td>{r.message}{r.data && <span className="muted"> {open ? '▾' : '▸'}</span>}</td>
      </tr>
      {open && <tr><td colSpan={5}><pre>{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</pre></td></tr>}
    </>
  )
}
