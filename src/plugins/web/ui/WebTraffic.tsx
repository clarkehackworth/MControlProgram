import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Alert, Badge, Field, Modal, PendingAsks, RuleGroup, api, useAction, useApi, type RuleOps, type Server } from '@mcontrolprogram/ui'

type Kind = 'domain' | 'url' | 'regex'
type Action = 'block' | 'ask' | 'allow'
type Policy = 'allow' | 'ask' | 'deny'
interface Rule { id: number; action: Action; kind: Kind; value: string; note: string; created_at: number }
/** A request-log row. Common fields here; a flavor's own columns read the rest. `now` = the current verdict (server-side). */
export interface Req { id: number; ts: number; principal: string | null; url: string; host: string; blocked: string | null; allowed_by: string | null
  now: { blocked: boolean; ask: boolean; by: string }; [k: string]: any }
export interface Target { action: Action; kind: Kind; value: string; url?: string }

/**
 * What differs between users of this panel: the web plugin (default) and plugins that reuse it for
 * their own rule list (browserpaw, which depends on web). Rules and verdicts always come from `plugin`'s actions.
 */
export interface TrafficFlavor {
  /** Under the rule groups. */
  rulesNote: ReactNode
  askDesc?: string
  /** Extra status under the rules (e.g. which browsers enforce the list). */
  RulesStatus?: ComponentType<{ rules: Rule[] }>
  log: {
    /** Extra filter keys sent to the `requests` action, with their initial values, and their inputs. */
    filters: Record<string, string>
    Filters: ComponentType<{ f: Record<string, string>; set: (k: string, v: string) => void }>
    /** Offer an "Errors" outcome filter. */
    errors?: boolean
    /** Column titles before the URL and after Access. */
    head: [string[], string[]]
    /** Called once per render of the log (may use hooks): the cells for those columns, and notes under Access. */
    useCells: () => { before: (r: Req) => ReactNode; after: (r: Req) => ReactNode; access?: (r: Req) => ReactNode }
  }
}

const webFlavor: TrafficFlavor = {
  rulesNote: <p className="muted small" style={{ marginBottom: 0 }}>Applies to every Web instance on every server, immediately (no restart, cookie jars are kept), including on redirects. Each instance's own allow/deny lists are checked after these. Only http and https are ever allowed.</p>,
  log: {
    filters: { server: '', method: '' },
    Filters: function WebFilters({ f, set }) {
      const [servers] = useApi<Server[]>('/servers')
      return <>
        <select value={f.server} onChange={(e) => set('server', e.target.value)} style={{ width: 160 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select value={f.method} onChange={(e) => set('method', e.target.value)} style={{ width: 120 }}><option value="">All methods</option>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}</select>
      </>
    },
    errors: true,
    head: [['Server / agent', 'Method'], ['Response']],
    useCells() {
      const [servers] = useApi<Server[]>('/servers')
      const sname = (id: string) => servers?.find((s) => s.id === id)?.name ?? id
      return {
        before: (r) => <>
          <td className="small" style={{ whiteSpace: 'nowrap' }}>{sname(r.server_id)}{r.instance !== 'web' ? `/${r.instance}` : ''}<div className="muted">{r.principal ?? '—'}</div></td>
          <td><Badge kind={r.method === 'GET' || r.method === 'HEAD' ? undefined : 'warn'}>{r.method}</Badge></td>
        </>,
        after: (r) => <td style={{ whiteSpace: 'nowrap' }}>
          {r.blocked ? <span className="muted small">—</span> : r.error ? <><Badge kind="err">failed</Badge> <span className="muted small" title={r.error}>{r.error.slice(0, 40)}</span></>
            : <><Badge kind={r.status >= 400 ? 'err' : r.status >= 300 ? 'info' : undefined}>{r.status}</Badge>{r.ms != null && <span className="muted small"> {r.ms} ms</span>}</>}
        </td>,
      }
    },
  },
}

const Plugin = createContext<string>('web')
const Flavor = createContext<TrafficFlavor>(webFlavor)
const actFor = (plugin: string) => <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/${plugin}/actions/${key}`, { method: 'POST', body }).then((r) => r.result)
const useAct = () => actFor(useContext(Plugin))
const recentRequests = (act: ReturnType<typeof actFor>) => act<{ rows: Req[] }>('requests', { since: Date.now() - 7 * 86400e3, limit: 5000 }).then((r) => r.rows)

const KINDS: { kind: Kind; title: string; label: string; help: string; placeholder: string }[] = [
  { kind: 'domain', title: 'Domains', label: 'Domain', help: 'The domain and all its subdomains.', placeholder: 'example.com' },
  { kind: 'url', title: 'URLs', label: 'URL prefix', help: 'Every URL that starts with this.', placeholder: 'https://example.com/admin/' },
  { kind: 'regex', title: 'Patterns', label: 'Pattern (regex)', help: 'Case-insensitive regular expression tested against the full URL.', placeholder: '\\.(exe|zip)$' },
]
const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]

/** The `check` action: server-side verdicts, so this UI never re-implements rule matching. */
interface Check { now: Req['now'][]; matches?: boolean[]; conflicts?: number[]; error?: string }
const ruleText = (s: string | null) => s === 'default: deny' ? 'not on allow list' : s === 'default: allow' ? 'allowed by default' : s?.replace(/^awaiting approval: /, '') ?? ''
const asked = (blocked: string | null) => !!blocked?.startsWith('awaiting approval')
const POLICIES = [['allow', 'Allow by default', 'Agents can reach any URL except blocked (or ask) ones.'], ['ask', 'Ask by default', 'URLs not on the allow list wait for your approval.'], ['deny', 'Deny by default', 'Agents can reach only allowed URLs. Blocked ones stay blocked.']] as const
export const urlNoQuery = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname } catch { return u } }
/** Prefill for the rule dialog from an ask: block the domain, allow the URL without its query. */
export const urlTarget = (s: any, action: 'allow' | 'block'): Target => action === 'block' ? { action, kind: 'domain', value: s.host as string, url: s.url } : { action, kind: 'url', value: urlNoQuery(s.url), url: s.url }
export const fmt = (ts: number) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString() }
const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)

/** Access rules (default policy + block/ask/allow by domain, URL prefix, regex), pending asks and the request log of `plugin`'s list. */
export default function WebTraffic({ plugin = 'web', flavor = webFlavor }: { plugin?: string; flavor?: TrafficFlavor }) {
  return <Plugin.Provider value={plugin}><Flavor.Provider value={flavor}><PendingAsks plugin={plugin} title="Requests waiting for approval" hideEmpty /><AccessRules /></Flavor.Provider></Plugin.Provider>
}

/** The rule dialog on its own (Approvals page): loads the rules itself. `onDone` gets the action saved. */
export function UrlRuleDialog({ plugin, init, onClose, onDone }: { plugin: string; init: Target; onClose: () => void; onDone: (action: Action) => Promise<void> }) {
  const [state, setState] = useState<{ policy: Policy; rules: Rule[] }>()
  useEffect(() => { void actFor(plugin)<{ policy: Policy; rules: Rule[] }>('rules').then(setState) }, [plugin])
  return state ? <Plugin.Provider value={plugin}><RuleDialog init={init} state={state} onClose={onClose} onDone={onDone} /></Plugin.Provider> : null
}

function AccessRules() {
  const act = useAct()
  const flavor = useContext(Flavor)
  const [state, setState] = useState<{ policy?: Policy; rules: Rule[] }>({ rules: [] }) // no policy until loaded: no radio lit
  const [dialog, setDialog] = useState<Target>()
  const [switching, setSwitching] = useState<Policy>()
  const { run, error } = useAction()
  const load = useCallback(() => run(async () => {
    setState(await act('rules'))
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const { policy, rules } = state
  const allowCount = rules.filter((r) => r.action === 'allow').length

  const del = (r: Rule) => {
    const what = r.action === 'block' ? 'Agents will be able to reach it again' + (policy !== 'allow' ? ' if it is on the allow list.' : '.') : r.action === 'ask' ? 'Matching URLs will no longer wait for approval.' : `Agents will no longer be able to reach it unless the default is allow${policy === 'ask' ? ' (it will ask)' : ''}.`
    if (window.confirm(`Remove ${r.action} rule for ${r.kind} "${r.value}"? ${what}`)) void run(async () => { await act('delete_rule', { id: r.id }); await load() })
  }
  /** Rule operations for the chips and the Manage dialog of one action's group. */
  const opsFor = (group: Action): RuleOps<Rule> => ({
    onDelete: del,
    remove: async (ids) => { for (const id of ids) await act('delete_rule', { id }); await load() },
    // the action is part of the upsert; under default allow an allow rule isn't stored, so moving to allow = removing
    move: async (r, action) => {
      if (action === 'allow' && policy === 'allow') await act('delete_rule', { id: r.id })
      else await act('rule', { action, kind: r.kind, value: r.value, note: r.note, ...('host' in r ? { host: r.host } : {}) })
      await load()
    },
    add: (kind) => setDialog({ action: group, kind: kind as Rule['kind'], value: '' }),
  })
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
            <button className="sm" onClick={() => setDialog({ action: 'ask', kind: 'domain', value: '' })}>+ Ask…</button>
            {policy !== 'allow' && <button className="sm" onClick={() => setDialog({ action: 'allow', kind: 'domain', value: '' })}>+ Allow…</button>}
          </div>
        </div>
        {error && <Alert kind="err">{error}</Alert>}

        <div className="row" style={{ margin: '12px 0', gap: 8, alignItems: 'stretch' }} role="radiogroup" aria-label="Default policy">
          {POLICIES.map(([p, t, d]) =>
            <button key={p} role="radio" aria-checked={policy === p} className={policy === p ? 'primary' : ''} style={{ flex: 1, textAlign: 'left', padding: '8px 12px' }}
              onClick={() => policy !== p && (p === 'allow' ? toAllow() : setSwitching(p))}>
              <strong>{policy === p ? '● ' : '○ '}{t}</strong><div className="small" style={{ opacity: 0.8 }}>{d}</div>
            </button>)}
        </div>

        <RuleGroup title="Blocked" kind="err" rules={rules.filter((r) => r.action === 'block')} kinds={KINDS} ops={opsFor('block')}
          desc="Always refused, even if an ask or allow rule also matches." />
        <RuleGroup title="Ask" kind="warn" rules={rules.filter((r) => r.action === 'ask')} kinds={KINDS} ops={opsFor('ask')}
          desc={flavor.askDesc ?? 'Wait for your approval, even if an allow rule also matches.'} />
        {(policy !== 'allow' || allowCount > 0) && <RuleGroup title="Allowed" kind="ok" rules={rules.filter((r) => r.action === 'allow')} kinds={KINDS} ops={opsFor('allow')}
          desc={policy === 'deny' ? 'The only URLs agents can reach.' : policy === 'ask' ? 'Reached without asking.' : 'Not in use while the default is allow; kept for when you switch to ask or deny.'} dim={policy === 'allow'} />}
        {flavor.rulesNote}
        {flavor.RulesStatus && <flavor.RulesStatus rules={rules} />}
      </div>
      {policy && <RequestLog state={{ policy, rules }} onRule={setDialog} />}
      {dialog && policy && <RuleDialog init={dialog} state={{ policy, rules }} onClose={() => setDialog(undefined)} onDone={async () => { setDialog(undefined); await load() }} />}
      {switching && <DenyDialog to={switching} onClose={() => setSwitching(undefined)} onDone={async () => { setSwitching(undefined); await load() }} />}
    </>
  )
}

/** Switching to ask/deny: offer to allow every host that was reached recently, so nothing that works today silently breaks (or starts asking). */
function DenyDialog({ to, onClose, onDone }: { to: Policy; onClose: () => void; onDone: () => Promise<void> }) {
  const act = useAct()
  const [hosts, setHosts] = useState<[string, number][]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { run, busy, error } = useAction()
  useEffect(() => {
    void recentRequests(act).then(async (rows) => {
      const ok = rows.filter((r) => !r.blocked && /^(https?|wss?):/i.test(r.url))
      const urls = [...new Set(ok.map((r) => r.url))]
      // would the default (not a block rule) refuse it under deny?
      const { now } = await act<Check>('check', { urls, policy: 'deny' })
      const refused = new Set(urls.filter((_, i) => now[i]!.by === 'default: deny'))
      const n = new Map<string, number>()
      for (const r of ok) if (refused.has(r.url)) n.set(r.host, (n.get(r.host) ?? 0) + 1)
      const list = [...n].sort((a, b) => b[1] - a[1])
      setHosts(list); setPicked(new Set(list.map(([h]) => h)))
    }).catch(() => setHosts([]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (h: string) => { const s = new Set(picked); if (s.has(h)) s.delete(h); else s.add(h); setPicked(s) }
  return (
    <Modal title={`Switch to ${to} by default`} onClose={onClose}>
      {to === 'deny'
        ? <p>Agents will only be able to reach URLs on the allow list. Everything else is refused, and shows as <Badge kind="err">Blocked</Badge> in the request log with an <em>Allow</em> button.</p>
        : <p>URLs on the allow list are reached; everything else waits for your approval (here and on the Approvals page). Agents are told to check back, then to pause.</p>}
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
        <button className="primary" disabled={busy || !hosts} onClick={() => run(async () => { await act('set_policy', { policy: to, allow: [...picked] }); await onDone() })}>
          {to === 'deny' ? 'Deny' : 'Ask'} by default{picked.size ? ` & allow ${picked.size}` : ''}
        </button>
      </div>
    </Modal>
  )
}

function RuleDialog({ init, state, onClose, onDone }: { init: Target; state: { policy: Policy; rules: Rule[] }; onClose: () => void; onDone: (action: Action) => Promise<void> }) {
  const act = useAct()
  const { policy, rules } = state
  const [action, setAction] = useState(init.action)
  const [kind, setKind] = useState(init.kind)
  const [value, setValue] = useState(init.value)
  const [note, setNote] = useState('')
  const [recent, setRecent] = useState<Req[]>([])
  const [keep, setKeep] = useState<Set<number>>(new Set()) // overriding rules the admin chose NOT to remove
  const { run, busy, error } = useAction()
  useEffect(() => { void recentRequests(act).then(setRecent).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const k = KINDS.find((x) => x.kind === kind)!
  const v = value.trim()
  // The server says which recent URLs the draft matches and which stored rules override it (block beats ask beats allow).
  const urls = useMemo(() => [...new Set(recent.map((r) => r.url))], [recent])
  const [chk, setChk] = useState<Check>()
  useEffect(() => {
    if (!v) { setChk(undefined); return }
    const t = setTimeout(() => void act<Check>('check', { urls, rule: { kind, value: v }, action, probes: init.url ? [init.url] : [] }).then(setChk, (e: Error) => setChk({ now: [], error: e.message })), 200)
    return () => clearTimeout(t)
  }, [urls, kind, v, action, init.url]) // eslint-disable-line react-hooks/exhaustive-deps
  const regexErr = v ? chk?.error : undefined
  const hits = useMemo(() => { const m = new Set(urls.filter((_, i) => chk?.matches?.[i])); return v && !regexErr ? recent.filter((r) => m.has(r.url)) : [] }, [chk, urls, recent, v, regexErr])
  const conflicts = v && !regexErr ? rules.filter((r) => chk?.conflicts?.includes(r.id)) : []
  const remove = conflicts.filter((r) => !keep.has(r.id))
  const kept = conflicts.filter((r) => keep.has(r.id))
  const allowNoop = action === 'allow' && policy === 'allow' && remove.length === 0
  const domainPicks = kind === 'domain' && init.kind === 'domain' && init.value ? init.value.split('.').map((_, i, a) => a.slice(i).join('.')).filter((d) => d.includes('.')) : []
  const canSave = !busy && !!v && !!chk && !regexErr && !allowNoop

  const save = () => run(async () => { await act('rule', { action, kind, value: v, note, remove: remove.map((r) => r.id) }); await onDone(action) })
  const verb = action === 'block' ? 'Block' : action === 'ask' ? 'Ask' : 'Allow'

  return (
    <Modal title={action === 'ask' ? 'Ask before access' : `${verb} access`} onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <Field label="Action">
        <div className="row">
          <label className="toggle"><input type="radio" name="action" checked={action === 'block'} onChange={() => setAction('block')} /> Block</label>
          <label className="toggle"><input type="radio" name="action" checked={action === 'ask'} onChange={() => setAction('ask')} /> Ask</label>
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
        <p className="small" style={{ margin: '0 0 4px' }}><strong>Rules that override this</strong> <span className="muted">— block wins over ask, ask over allow. Ticked ones are removed:</span></p>
        {conflicts.map((r) => <label key={r.id} style={{ display: 'block' }} className="small">
          <input type="checkbox" checked={!keep.has(r.id)} onChange={() => { const s = new Set(keep); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setKeep(s) }} /> {r.action} {r.kind}: <span className="mono">{r.value}</span>
        </label>)}
      </div>}

      {action !== 'allow' || policy !== 'allow' ? <Field label="Note (optional)"><input type="text" placeholder={`Why is this ${action === 'block' ? 'blocked' : action === 'ask' ? 'asked' : 'allowed'}?`} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} /></Field> : null}

      {v && !regexErr && <div className="small" style={{ margin: '8px 0' }}>
        <div>{hits.length ? <>Matches <strong>{hits.length}</strong> of {recent.length} requests in the last 7 days, e.g. <span className="mono">{hits[0]!.url}</span></> : <span className="muted">Matches none of the {recent.length} requests in the last 7 days.</span>}</div>
        <div style={{ marginTop: 4 }}>
          {action === 'block' && 'Adds a block rule. Matching URLs are refused whatever the default policy is.'}
          {action === 'ask' && 'Adds an ask rule. Matching URLs wait for your approval.'}
          {action === 'allow' && policy !== 'allow' && 'Adds an allow rule.'}
          {action === 'allow' && policy === 'allow' && (remove.length ? `Removes ${remove.length} block rule${remove.length === 1 ? '' : 's'}. No allow rule is needed while the default is allow.` : <span className="muted">Already allowed: the default is allow and no selected block rule covers it.</span>)}
          {kept.length > 0 && <div className="err">Still overridden by {kept.map((r) => `${r.action} ${r.kind}: ${r.value}`).join(', ')}.</div>}
        </div>
      </div>}

      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className={action === 'block' ? 'danger' : 'primary'} disabled={!canSave} onClick={save}>{verb}</button>
      </div>
    </Modal>
  )
}

function RequestLog({ state, onRule }: { state: { policy: Policy; rules: Rule[] }; onRule: (t: Target) => void }) {
  const act = useAct()
  const { log } = useContext(Flavor)
  const cells = log.useCells()
  const [range, setRange] = useState<number | 'custom'>(86400e3)
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 86400e3))
  const [to, setTo] = useState(() => toLocalInput(Date.now()))
  const [f, setF] = useState<Record<string, string>>(() => ({ q: '', outcome: '', ...log.filters }))
  const [live, setLive] = useState(true)
  const [data, setData] = useState<{ rows: Req[]; more: boolean }>()
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    const [since, until] = range === 'custom' ? [new Date(from).getTime(), new Date(to).getTime()] : [Date.now() - range, Date.now()]
    setData(await act('requests', { since, until, ...f }))
  }), [range, from, to, f, state.rules, state.policy]) // eslint-disable-line react-hooks/exhaustive-deps -- rules change → rows' `now` recomputed
  useEffect(() => {
    void load()
    if (!live || range === 'custom') return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load, live, range])
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
        <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} style={{ width: 130 }}><option value="">Allowed & blocked</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option>{log.errors && <option value="error">Errors</option>}</select>
        <log.Filters f={f} set={(k, v) => setF({ ...f, [k]: v })} />
        <input type="text" placeholder="Search URL or agent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 220 }} />
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Time</th>{log.head[0].map((h) => <th key={h}>{h}</th>)}<th>URL</th><th>Access</th>{log.head[1].map((h) => <th key={h}>{h}</th>)}<th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const now = r.now
            const wasAsked = asked(r.blocked)
            const changed = now.blocked !== (!!r.blocked && !wasAsked) || !!now.ask !== wasAsked
            const base = urlNoQuery(r.url)
            const stopped = now.blocked || now.ask
            const next = stopped ? 'allow' : 'block'
            const Verb = stopped ? 'Allow' : 'Block'
            return <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              {cells.before(r)}
              <td className="mono" style={{ width: '100%', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>{r.url}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {wasAsked ? <Badge kind="warn">Asked</Badge> : r.blocked ? <Badge kind="err">Blocked</Badge> : <Badge kind="ok">Allowed</Badge>}
                <span className="muted small"> {ruleText(r.blocked ?? r.allowed_by)}</span>
                {cells.access?.(r)}
                {changed && <div className="small" style={{ fontStyle: 'italic' }}>now {now.blocked ? 'blocked' : now.ask ? 'asks' : 'allowed'}</div>}
              </td>
              {cells.after(r)}
              <td>{/^(https?|wss?):/i.test(r.url) && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, whiteSpace: 'nowrap' }}>
                <button className={`sm${stopped ? '' : ' danger'}`} title={`${Verb} ${r.host} and its subdomains`} onClick={() => onRule({ action: next, kind: 'domain', value: r.host, url: r.url })}>{Verb} domain</button>
                <button className={`sm${stopped ? '' : ' danger'}`} title={`${Verb} URLs starting with ${base}`} onClick={() => onRule({ action: next, kind: 'url', value: base, url: r.url })}>{Verb} URL</button>
              </div>}</td>
            </tr>
          })}
          {rows.length === 0 && <tr><td colSpan={log.head[0].length + log.head[1].length + 4} className="muted">{data ? 'No requests in this timeframe.' : 'Loading…'}</td></tr>}
        </tbody>
      </table>
      </div>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older requests.</p>}
    </div>
  )
}
