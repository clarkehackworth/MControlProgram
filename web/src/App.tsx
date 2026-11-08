import { useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { api, useApi } from './api'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Servers from './pages/Servers'
import ServerDetail from './pages/ServerDetail'
import Plugins from './pages/Plugins'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import Approvals from './pages/Approvals'
import PluginPage, { inventoryKeys } from './pages/PluginPage'
import type { Approval, PluginMeta } from './api'

function Shell({ user, onLogout, children }: { user: string; onLogout: () => void; children: React.ReactNode }) {
  const [appr] = useApi<{ pending: Approval[] }>('/approvals', 5000)
  const n = appr?.pending.length ?? 0
  const nav = useNavigate()
  // Browser notifications for new approvals. Needs HTTPS or localhost; ponytail: only while a tab is open, add Web Push if needed without one.
  const canNotify = typeof Notification !== 'undefined'
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied')
  const seen = useRef<Set<string>>(undefined)
  useEffect(() => {
    if (!appr) return
    const ids = new Set(appr.pending.map((a) => a.id))
    const fresh = seen.current ? appr.pending.filter((a) => !seen.current!.has(a.id)) : [] // first load: don't notify for the backlog
    seen.current = ids
    if (perm !== 'granted' || (!document.hidden && document.hasFocus())) return
    for (const a of fresh) {
      const note = new Notification('Approval needed', { body: `${a.summary || a.tool}\n${a.tool} by ${a.principal} · ${a.instance_name}`, tag: a.id })
      note.onclick = () => { window.focus(); nav('/approvals'); note.close() }
    }
  }, [appr]) // eslint-disable-line react-hooks/exhaustive-deps
  const [sys] = useApi<{ version: string }>('/system')
  const [plugins] = useApi<PluginMeta[]>('/plugins')
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">MControlProgram<div className="muted small mono"><img src="/favicon.svg" alt="" width={14} height={14} />{sys && <> v{sys.version}</>}</div></div>
        {plugins?.filter((p) => inventoryKeys(p).length > 0).sort((a, b) => (a.navOrder ?? Infinity) - (b.navOrder ?? Infinity) || a.name.localeCompare(b.name)).map((p) => <NavLink key={p.id} to={`/p/${p.id}`}>{p.name}</NavLink>)}
        <NavLink to="/servers">MCP Servers</NavLink>
        <NavLink to="/plugins">Plugins</NavLink>
        <NavLink to="/approvals">Approvals{n > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{n}</span>}</NavLink>
        <NavLink to="/logs">Logs</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="main">
        <div className="topbar">{canNotify && perm === 'default' && <button className="sm" title="Get a browser notification when an approval is waiting" onClick={() => void Notification.requestPermission().then(setPerm)}>Enable notifications</button>}<span>{user}</span><button className="sm" onClick={onLogout}>Logout</button></div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<string | null | undefined>()
  const [setupNeeded, setSetupNeeded] = useState(false)
  const nav = useNavigate()
  useEffect(() => {
    api<{ needed: boolean }>('/setup').then((s) => setSetupNeeded(s.needed)).catch(() => {})
    api<{ username: string } | null>('/auth/me').then((u) => setUser(u?.username ?? null)).catch(() => setUser(null))
  }, [])
  if (user === undefined) return null
  if (setupNeeded && !user) return <Setup onDone={(u) => { setSetupNeeded(false); setUser(u); nav('/servers') }} />
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); nav('/login') }
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/servers" /> : <Login onLogin={setUser} />} />
      <Route path="/*" element={!user ? <Navigate to="/login" /> : (
        <Shell user={user} onLogout={logout}>
          <Routes>
            <Route path="/" element={<Navigate to="/servers" />} />
            <Route path="/servers" element={<Servers />} />
            <Route path="/servers/:id" element={<ServerDetail />} />
            <Route path="/plugins" element={<Plugins />} />
            <Route path="/p/:id" element={<PluginPage />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Shell>
      )} />
    </Routes>
  )
}
