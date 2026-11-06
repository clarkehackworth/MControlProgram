import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, useApi, type Server } from '../api'
import { Alert, Badge, Field, Modal, useAction } from '../components/ui'

type Kind = 'domain' | 'url' | 'regex'
type Action = 'block' | 'allow'
type Policy = 'allow' | 'deny'
interface Rule { id: number; action: Action; kind: Kind; value: string; note: string; created_at: number }
interface Req { id: number; ts: number; server_id: string; instance: string; principal: string | null; method: string; url: string; host: string; status: number | null; error: string | null; blocked: string | null; allowed_by: string | null; ms: number | null
  // browserpaw only
  profile?: string; session_id?: string | null; agent_via?: 'tool' | 'inherited' | 'inferred' | null; tab_id?: number | null; type?: string; via?: 'dnr' | 'nav-guard' | 'tool-arg' | 'observed' | 'dropped' }
type PluginId = 'web' | 'browserpaw'
interface Sync { inSync: boolean; ackRev: number | null; rev: number; lastPull: number | null; error: string | null; rejected: { id: number; error: string }[] }
interface Target { action: Action; kind: Kind; value: string; url?: string }

const Plugin = createContext<PluginId>('web')
const actFor = (plugin: PluginId) => <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/${plugin}/actions/${key}`, { method: 'POST', body }).then((r) => r.result)
const useAct = () => actFor(useContext(Plugin))
const recentRequests = (act: ReturnType<typeof actFor>) => act<{ rows: Req[] }>('requests', { since: Date.now() - 7 * 86400e3, limit: 5000 }).then((r) => r.rows)
const VIA: Record<string, string> = { dnr: 'blocked in the browser', 'nav-guard': 'blocked in the browser (scheme)', 'tool-arg': 'refused before reaching the browser', observed: 'seen in the browser', dropped: 'log gap' }
const AGENT_VIA: Record<string, string> = { tool: 'the agent drove this tab', inherited: 'tab opened from an agent tab', inferred: 'only agent active at the time (best guess)' }

const KINDS: { kind: Kind; title: string; label: string; help: string; placeholder: string }[] = [
  { kind: 'domain', title: 'Domains', label: 'Domain', help: 'The domain and all its subdomains.', placeholder: 'example.com' },
  { kind: 'url', title: 'URLs', label: 'URL prefix', help: 'Every URL that starts with this.', placeholder: 'https://example.com/admin/' },
  { kind: 'regex', title: 'Patterns', label: 'Pattern (regex)', help: 'Case-insensitive regular expression tested against the full URL.', placeholder: '\\.(exe|zip)$' },
]
const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]

/** Mirror of the server's ruleMatches()/verdict(): block rules win, then allow rules, then the default policy. */
function matches(r: Pick<Rule, 'kind' | 'value'>, url: string) {
  if (!r.value) return false
  let host = ''; try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '') } catch { /* not a URL */ }
  if (r.kind === 'domain') { const d = r.value.toLowerCase().replace(/^\*?\./, '').replace(/\.+$/, ''); return host === d || host.endsWith('.' + d) }
  if (r.kind === 'url') return url.startsWith(r.value)
  try { return new RegExp(r.value, 'i').test(url) } catch { return false }
}
function verdict(url: string, rules: Rule[], policy: Policy): { blocked: boolean; by?: Rule } {
  const b = rules.find((r) => r.action === 'block' && matches(r, url))
  if (b) return { blocked: true, by: b }
  const a = rules.find((r) => r.action === 'allow' && matches(r, url))
  return a ? { blocked: false, by: a } : { blocked: policy === 'deny' }
}
const ruleText = (s: string | null) => s === 'default: deny' ? 'not on allow list' : s === 'default: allow' ? 'allowed by default' : s ?? ''
const urlNoQuery = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname } catch { return u } }
const fmt = (ts: number) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString() }
const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)

/** Access rules (default policy + block/allow by domain, URL prefix, regex) and the request log, for the web plugin or the browser (browserpaw). */
export default function WebTraffic({ plugin = 'web' }: { plugin?: PluginId }) {
  return <Plugin.Provider value={plugin}><AccessRules plugin={plugin} /></Plugin.Provider>
}

function AccessRules({ plugin }: { plugin: PluginId }) {
  const act = useAct()
  const browser = plugin === 'browserpaw'
  const [sync, setSync] = useState<Record<string, Sync>>({})
  const [state, setState] = useState<{ policy: Policy; rules: Rule[] }>({ policy: 'allow', rules: [] })
  const [dialog, setDialog] = useState<Target>()
  const [switching, setSwitching] = useState(false)
  const { run, error } = useAction()
  const load = useCallback(() => run(async () => {
    setState(await act('rules'))
    if (browser) setSync((await act<{ profiles: Record<string, Sync> }>('sync_status')).profiles)
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!browser) return
    const t = setInterval(() => void act<{ profiles: Record<string, Sync> }>('sync_status').then((r) => setSync(r.profiles)).catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [browser]) // eslint-disable-line react-hooks/exhaustive-deps
  const { policy, rules } = state
  const allowCount = rules.filter((r) => r.action === 'allow').length

  const del = (r: Rule) => {
    const what = r.action === 'block' ? 'Agents will be able to reach it again' + (policy === 'deny' ? ' if it is on the allow list.' : '.') : 'Agents will no longer be able to reach it unless the default is allow.'
    if (window.confirm(`Remove ${r.action} rule for ${r.kind} "${r.value}"? ${what}`)) void run(async () => { await act('delete_rule', { id: r.id }); await load() })
  }
  const toAllow = () => {
    if (window.confirm(`Allow by default?\n\nAgents will be able to reach any URL that isn't blocked.${allowCount ? ` Your ${allowCount} allow rule(s) are kept for when you switch back.` : ''}`))
      void run(async () => { await act('set_policy', { policy: 'allow' }); await load() })
  }

  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Access rules</h2>
          <div className="row">
            <button className="sm" onClick={() => setDialog({ action: 'block', kind: 'domain', value: '' })}>+ Block…</button>
            {policy === 'deny' && <button className="sm" onClick={() => setDialog({ action: 'allow', kind: 'domain', value: '' })}>+ Allow…</button>}
          </div>
        </div>
        {error && <Alert kind="err">{error}</Alert>}

        <div className="row" style={{ margin: '12px 0', gap: 8, alignItems: 'stretch' }} role="radiogroup" aria-label="Default policy">
          {([['allow', 'Allow by default', 'Agents can reach any URL except blocked ones.'], ['deny', 'Deny by default', 'Agents can reach only allowed URLs. Blocked ones stay blocked.']] as const).map(([p, t, d]) =>
            <button key={p} role="radio" aria-checked={policy === p} className={policy === p ? 'primary' : ''} style={{ flex: 1, textAlign: 'left', padding: '8px 12px' }}
              onClick={() => policy !== p && (p === 'deny' ? setSwitching(true) : toAllow())}>
              <strong>{policy === p ? '● ' : '○ '}{t}</strong><div className="small" style={{ opacity: 0.8 }}>{d}</div>
            </button>)}
        </div>

        <RuleGroup title="Blocked" kind="err" rules={rules.filter((r) => r.action === 'block')} onDelete={del}
          desc="Always refused, even if an allow rule also matches." />
        {(policy === 'deny' || allowCount > 0) && <RuleGroup title="Allowed" kind="ok" rules={rules.filter((r) => r.action === 'allow')} onDelete={del}
          desc={policy === 'deny' ? 'The only URLs agents can reach.' : 'Not in use while the default is allow; kept for when you switch to deny.'} dim={policy !== 'deny'} />}
        {browser
          ? <p className="muted small" style={{ marginBottom: 0 }}>Separate from the Web plugin's list. Applies to every BrowserPaw profile and everything the browser loads (pages, frames, scripts, fetch/XHR, websockets), pushed to running browsers immediately. A browser that hasn't confirmed the current list gets no tool calls and blocks all traffic. <code>file:</code>, <code>chrome:</code>, <code>ftp:</code>, <code>ssh:</code> and other non-web schemes are always refused. Patterns use the browser's regex engine (no lookahead or backreferences).</p>
          : <p className="muted small" style={{ marginBottom: 0 }}>Applies to every Web instance on every server, immediately (no restart, cookie jars are kept), including on redirects. Each instance's own allow/deny lists are checked after these. Only http and https are ever allowed.</p>}
        {browser && Object.keys(sync).length > 0 && <div className="row small" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="muted">Browsers:</span>
          {Object.entries(sync).map(([n, x]) => <span key={n} title={[x.error, ...x.rejected.map((r) => `rule ${rules.find((y) => y.id === r.id)?.value ?? r.id}: ${r.error}`), x.lastPull ? `last report ${fmt(x.lastPull)}` : ''].filter(Boolean).join('\n')}>
            <Badge kind={x.error ? 'err' : x.inSync ? (x.rejected.length ? 'warn' : 'ok') : 'warn'}>{n}: {x.error ? 'error' : x.inSync ? (x.rejected.length ? `${x.rejected.length} rule(s) rejected` : 'in sync') : 'pending'}</Badge>
          </span>)}
        </div>}
      </div>
      <RequestLog state={state} onRule={setDialog} browser={browser} />
      {dialog && <RuleDialog init={dialog} state={state} onClose={() => setDialog(undefined)} onDone={async () => { setDialog(undefined); await load() }} />}
      {switching && <DenyDialog rules={rules} onClose={() => setSwitching(false)} onDone={async () => { setSwitching(false); await load() }} />}
    </>
  )
}

function RuleGroup({ title, kind, rules, desc, dim, onDelete }: { title: string; kind: 'ok' | 'err'; rules: Rule[]; desc: string; dim?: boolean; onDelete: (r: Rule) => void }) {
  return (
    <div style={{ marginTop: 12, opacity: dim ? 0.6 : 1 }}>
      <div><Badge kind={kind}>{title}</Badge> <span className="muted small">({rules.length}) — {desc}</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 6 }}>
        {KINDS.map((k) => {
          const list = rules.filter((r) => r.kind === k.kind)
          return <div key={k.kind}>
            <strong className="small">{k.title}</strong>
            <div className="chips" style={{ marginTop: 4 }}>
              {list.map((r) => <span key={r.id} className="chip mono" title={`${r.note ? r.note + ' — ' : ''}added ${new Date(r.created_at).toLocaleString()}`}>
                {r.value}<button title="Remove" aria-label={`Remove ${title.toLowerCase()} ${r.value}`} onClick={() => onDelete(r)}>✕</button>
              </span>)}
              {list.length === 0 && <span className="muted small">None</span>}
            </div>
          </div>
        })}
      </div>
    </div>
  )
}

/** Switching to deny: offer to allow every host that was reached recently, so nothing that works today silently breaks. */
function DenyDialog({ rules, onClose, onDone }: { rules: Rule[]; onClose: () => void; onDone: () => Promise<void> }) {
  const act = useAct()
  const [hosts, setHosts] = useState<[string, number][]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { run, busy, error } = useAction()
  useEffect(() => {
    void recentRequests(act).then((rows) => {
      const n = new Map<string, number>()
      for (const r of rows) if (!r.blocked && /^(https?|wss?):/i.test(r.url) && verdict(r.url, rules, 'deny').blocked && !rules.some((x) => x.action === 'block' && matches(x, r.url))) n.set(r.host, (n.get(r.host) ?? 0) + 1)
      const list = [...n].sort((a, b) => b[1] - a[1])
      setHosts(list); setPicked(new Set(list.map(([h]) => h)))
    }).catch(() => setHosts([]))
  }, [rules])
  const toggle = (h: string) => { const s = new Set(picked); if (s.has(h)) s.delete(h); else s.add(h); setPicked(s) }
  return (
    <Modal title="Switch to deny by default" onClose={onClose}>
      <p>Agents will only be able to reach URLs on the allow list. Everything else is refused, and shows as <Badge kind="err">Blocked</Badge> in the request log with an <em>Allow</em> button.</p>
      {error && <Alert kind="err">{error}</Alert>}
      {!hosts ? <p className="muted">Checking recent traffic…</p> : hosts.length === 0 ? <p className="muted small">No recent traffic would be affected.</p> : <>
        <p className="small"><strong>Keep these working?</strong> They were used in the last 7 days and aren't on the allow list yet. Ticked domains are added to it.</p>
        <div className="row small" style={{ gap: 12 }}><a href="#" onClick={(e) => { e.preventDefault(); setPicked(new Set(hosts.map(([h]) => h))) }}>Select all</a><a href="#" onClick={(e) => { e.preventDefault(); setPicked(new Set()) }}>Select none</a></div>
        <div style={{ maxHeight: 260, overflow: 'auto', margin: '6px 0' }}>
          {hosts.map(([h, n]) => <label key={h} style={{ display: 'block' }}><input type="checkbox" checked={picked.has(h)} onChange={() => toggle(h)} /> <span className="mono">{h}</span> <span className="muted small">{n} request{n === 1 ? '' : 's'}</span></label>)}
        </div>
      </>}
      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !hosts} onClick={() => run(async () => { await act('set_policy', { policy: 'deny', allow: [...picked] }); await onDone() })}>
          Deny by default{picked.size ? ` & allow ${picked.size}` : ''}
        </button>
      </div>
    </Modal>
  )
}

function RuleDialog({ init, state, onClose, onDone }: { init: Target; state: { policy: Policy; rules: Rule[] }; onClose: () => void; onDone: () => Promise<void> }) {
  const act = useAct()
  const { policy, rules } = state
  const [action, setAction] = useState(init.action)
  const [kind, setKind] = useState(init.kind)
  const [value, setValue] = useState(init.value)
  const [note, setNote] = useState('')
  const [recent, setRecent] = useState<Req[]>([])
  const [keep, setKeep] = useState<Set<number>>(new Set()) // conflicting block rules the admin chose NOT to remove
  const { run, busy, error } = useAction()
  useEffect(() => { void recentRequests(act).then(setRecent).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const k = KINDS.find((x) => x.kind === kind)!
  const v = value.trim()
  const regexErr = kind === 'regex' && v ? (() => { try { new RegExp(v); return undefined } catch (e) { return (e as Error).message } })() : undefined
  const rule = { kind, value: v }
  const hits = useMemo(() => v && !regexErr ? recent.filter((r) => matches(rule, r.url)) : [], [recent, kind, v, regexErr]) // eslint-disable-line react-hooks/exhaustive-deps
  // Block rules win over allow rules, so allowing something means removing the blocks that cover it.
  const probes = useMemo(() => {
    const p = hits.map((r) => r.url)
    if (init.url) p.push(init.url)
    if (kind === 'url' && v) p.push(v)
    if (kind === 'domain' && v) p.push(`https://${v}/`)
    return p
  }, [hits, init.url, kind, v])
  const conflicts = action === 'allow' && v && !regexErr ? rules.filter((r) => r.action === 'block' && probes.some((u) => matches(r, u))) : []
  const remove = conflicts.filter((r) => !keep.has(r.id))
  const kept = conflicts.filter((r) => keep.has(r.id))
  const allowNoop = action === 'allow' && policy === 'allow' && remove.length === 0
  const domainPicks = kind === 'domain' && init.kind === 'domain' && init.value ? init.value.split('.').map((_, i, a) => a.slice(i).join('.')).filter((d) => d.includes('.')) : []
  const canSave = !busy && !!v && !regexErr && !allowNoop

  const save = () => run(async () => { await act('rule', { action, kind, value: v, note, remove: remove.map((r) => r.id) }); await onDone() })
  const verb = action === 'block' ? 'Block' : 'Allow'

  return (
    <Modal title={action === 'block' ? 'Block access' : 'Allow access'} onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <Field label="Action">
        <div className="row">
          <label className="toggle"><input type="radio" name="action" checked={action === 'block'} onChange={() => setAction('block')} /> Block</label>
          <label className="toggle"><input type="radio" name="action" checked={action === 'allow'} onChange={() => setAction('allow')} /> Allow</label>
        </div>
      </Field>
      <Field label="Match by">
        <div className="row">{KINDS.map((x) => <label key={x.kind} className="toggle"><input type="radio" name="kind" checked={kind === x.kind} onChange={() => setKind(x.kind)} /> {x.label}</label>)}</div>
      </Field>
      <Field label={k.label} desc={k.help}>
        <input type="text" className="mono" autoFocus placeholder={k.placeholder} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: '100%' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save() }} />
        {domainPicks.length > 1 && <div className="chips" style={{ marginTop: 6 }}>{domainPicks.map((d) => <button key={d} className={`sm${d === v ? ' primary' : ''}`} onClick={() => setValue(d)}>{d}</button>)}</div>}
        {regexErr && <div className="err small" style={{ marginTop: 4 }}>{regexErr}</div>}
      </Field>

      {conflicts.length > 0 && <div style={{ margin: '8px 0' }}>
        <p className="small" style={{ margin: '0 0 4px' }}><strong>Block rules that cover this</strong> <span className="muted">— block rules win over allow rules. Ticked ones are removed:</span></p>
        {conflicts.map((r) => <label key={r.id} style={{ display: 'block' }} className="small">
          <input type="checkbox" checked={!keep.has(r.id)} onChange={() => { const s = new Set(keep); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setKeep(s) }} /> {r.kind}: <span className="mono">{r.value}</span>
        </label>)}
      </div>}

      {action === 'block' || policy === 'deny' ? <Field label="Note (optional)"><input type="text" placeholder={`Why is this ${action === 'block' ? 'blocked' : 'allowed'}?`} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} /></Field> : null}

      {v && !regexErr && <div className="small" style={{ margin: '8px 0' }}>
        <div>{hits.length ? <>Matches <strong>{hits.length}</strong> of {recent.length} requests in the last 7 days, e.g. <span className="mono">{hits[0]!.url}</span></> : <span className="muted">Matches none of the {recent.length} requests in the last 7 days.</span>}</div>
        <div style={{ marginTop: 4 }}>
          {action === 'block' && 'Adds a block rule. Matching URLs are refused whatever the default policy is.'}
          {action === 'allow' && policy === 'deny' && 'Adds an allow rule.'}
          {action === 'allow' && policy === 'allow' && (remove.length ? `Removes ${remove.length} block rule${remove.length === 1 ? '' : 's'}. No allow rule is needed while the default is allow.` : <span className="muted">Already allowed: the default is allow and no selected block rule covers it.</span>)}
          {kept.length > 0 && <div className="err">Still blocked by {kept.map((r) => `${r.kind}: ${r.value}`).join(', ')}.</div>}
        </div>
      </div>}

      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className={action === 'block' ? 'danger' : 'primary'} disabled={!canSave} onClick={save}>{verb}</button>
      </div>
    </Modal>
  )
}

function RequestLog({ state, onRule, browser }: { state: { policy: Policy; rules: Rule[] }; onRule: (t: Target) => void; browser: boolean }) {
  const act = useAct()
  const [servers] = useApi<Server[]>(browser ? null : '/servers')
  const [range, setRange] = useState<number | 'custom'>(86400e3)
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 86400e3))
  const [to, setTo] = useState(() => toLocalInput(Date.now()))
  const [f, setF] = useState({ q: '', method: '', outcome: '', server: '', profile: '', via: '' })
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
        <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} style={{ width: 130 }}><option value="">Allowed & blocked</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option>{!browser && <option value="error">Errors</option>}</select>
        {browser
          ? <>
            <input type="text" placeholder="Profile" value={f.profile} onChange={(e) => setF({ ...f, profile: e.target.value })} style={{ width: 120 }} />
            <select value={f.via} onChange={(e) => setF({ ...f, via: e.target.value })} style={{ width: 190 }}><option value="">All sources</option>{Object.entries(VIA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </>
          : <select value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} style={{ width: 160 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        {!browser && <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} style={{ width: 120 }}><option value="">All methods</option>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}</select>}
        <input type="text" placeholder="Search URL or agent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 220 }} />
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Time</th><th>{browser ? 'Profile / agent' : 'Server / agent'}</th><th>{browser ? 'Type' : 'Method'}</th><th>URL</th><th>Access</th>{!browser && <th>Response</th>}<th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const now = verdict(r.url, state.rules, state.policy)
            const changed = now.blocked !== !!r.blocked
            const base = urlNoQuery(r.url)
            const next = now.blocked ? 'allow' : 'block'
            const Verb = now.blocked ? 'Allow' : 'Block'
            return <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              {browser
                ? <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.profile}{r.tab_id != null && r.tab_id >= 0 && <span className="muted"> · tab {r.tab_id}</span>}
                    <div className="muted" title={r.agent_via ? AGENT_VIA[r.agent_via] : 'no agent had used this tab (the user, or browser background traffic)'}>{r.principal ?? (r.agent_via ? '(unnamed agent)' : 'user / background')}{r.agent_via && r.agent_via !== 'tool' && <> <Badge>{r.agent_via}</Badge></>}</div></td>
                : <td className="small" style={{ whiteSpace: 'nowrap' }}>{sname(r.server_id)}{r.instance !== 'web' ? `/${r.instance}` : ''}<div className="muted">{r.principal ?? '—'}</div></td>}
              {browser
                ? <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.type}{r.method && r.method.toUpperCase() !== 'GET' && <> <Badge kind="warn">{r.method.toUpperCase()}</Badge></>}</td>
                : <td><Badge kind={r.method === 'GET' || r.method === 'HEAD' ? undefined : 'warn'}>{r.method}</Badge></td>}
              <td className="mono" style={{ width: '100%', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>{r.url}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked ? <Badge kind="err">Blocked</Badge> : <Badge kind="ok">Allowed</Badge>}
                <span className="muted small"> {ruleText(r.blocked ?? r.allowed_by)}</span>
                {browser && r.via && <div className="muted small">{VIA[r.via] ?? r.via}</div>}
                {changed && <div className="small" style={{ fontStyle: 'italic' }}>now {now.blocked ? 'blocked' : 'allowed'}</div>}
              </td>
              {!browser && <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked ? <span className="muted small">—</span> : r.error ? <><Badge kind="err">failed</Badge> <span className="muted small" title={r.error}>{r.error.slice(0, 40)}</span></>
                  : <><Badge kind={r.status! >= 400 ? 'err' : r.status! >= 300 ? 'info' : undefined}>{r.status}</Badge>{r.ms != null && <span className="muted small"> {r.ms} ms</span>}</>}
              </td>}
              <td>{/^(https?|wss?):/i.test(r.url) && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, whiteSpace: 'nowrap' }}>
                <button className={`sm${now.blocked ? '' : ' danger'}`} title={`${Verb} ${r.host} and its subdomains`} onClick={() => onRule({ action: next, kind: 'domain', value: r.host, url: r.url })}>{Verb} domain</button>
                <button className={`sm${now.blocked ? '' : ' danger'}`} title={`${Verb} URLs starting with ${base}`} onClick={() => onRule({ action: next, kind: 'url', value: base, url: r.url })}>{Verb} URL</button>
              </div>}</td>
            </tr>
          })}
          {rows.length === 0 && <tr><td colSpan={browser ? 6 : 7} className="muted">{data ? 'No requests in this timeframe.' : 'Loading…'}</td></tr>}
        </tbody>
      </table>
      </div>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older requests.</p>}
    </div>
  )
}
