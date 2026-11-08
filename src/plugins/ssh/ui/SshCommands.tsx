import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, LoadingRow, Field, Modal, PendingAsks, RuleGroup, api, useAction, useApi, type RuleOps, type Server } from '@mcontrolprogram/ui'

type Kind = 'program' | 'prefix' | 'regex' | 'write'
type Action = 'block' | 'ask' | 'allow'
type Policy = 'allow' | 'ask' | 'deny'
interface Rule { id: number; action: Action; kind: Kind; value: string; host: string; note: string; created_at: number }
interface Cmd { id: number; ts: number; server_id: string; instance: string; principal: string | null; host: string; tool: string; command: string; exit_code: number | null; error: string | null; blocked: string | null; allowed_by: string | null; ms: number | null; now_blocked?: boolean; now_ask?: boolean; programs?: string[]; single?: string; writes?: string[]; unknown?: string[] }
interface Target { action: Action; kind: Kind; value: string; host?: string; command?: string }
interface Why { verdict: { ask?: string; blocked?: string }; overriding: Rule[]; writes: string[]; unknown: string[] }
interface Preview { total: number; hits: number; example?: string; conflicts: Rule[] }

const act = <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/ssh/actions/${key}`, { method: 'POST', body }).then((r) => r.result)

const KINDS: { kind: Kind; title: string; label: string; help: string; placeholder: string }[] = [
  { kind: 'program', title: 'Programs', label: 'Program', help: 'A program name, wherever it runs in the command line: after ; && | $( … and behind sudo, env, xargs and similar. Several names separated by spaces add one rule each.', placeholder: 'rm' },
  { kind: 'prefix', title: 'Commands', label: 'Command prefix', help: 'Each command in the line that starts with this, in whole words ("git status" matches "git status -s", not "git statusx").', placeholder: 'git status' },
  { kind: 'regex', title: 'Patterns', label: 'Pattern (regex)', help: 'Regular expression tested against each command in the line (block rules also test the whole line). Case-sensitive.', placeholder: '^systemctl (status|restart) ' },
  { kind: 'write', title: 'Written files', label: 'Write to (path)', help: 'Output redirects (>, >>, &>) into this file or directory. "/tmp" covers /tmp/x but not /tmpfoo. /dev/null is always allowed. Only redirects: programs that write files themselves (cp, tee, sed -i…) are controlled by program rules.', placeholder: '/tmp' },
]
const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]
const ruleText = (s: string | null) => s === 'default: deny' ? 'not on allow list' : s === 'default: allow' ? 'allowed by default' : s?.replace(/^awaiting approval: /, '') ?? ''
const asked = (blocked: string | null) => !!blocked?.startsWith('awaiting approval')
const POLICIES = [['allow', 'Allow by default', 'Agents can run any command except blocked (or ask) ones.'], ['ask', 'Ask by default', 'Commands not on the allow list wait for your approval.'], ['deny', 'Deny by default', 'Agents can run only allowed commands. Blocked ones stay blocked.']] as const
const fmt = (ts: number) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString() }
const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)
const isCmd = (t: string) => t === 'exec' || t === 'shell'
const dirOf = (f: string) => f.includes('/') ? f.replace(/\/[^/]*$/, '') || '/' : f

/** SSH plugin: admin command rules (default policy + block/ask/allow by program, command prefix, regex; optionally per host), pending asks, and the log of what agents ran. */
export default function SshCommands({ hosts }: { hosts: string[] }) {
  const [state, setState] = useState<{ policy?: Policy; rules: Rule[] }>({ rules: [] }) // no policy until loaded: no radio lit
  const [dialog, setDialog] = useState<Target>()
  const [switching, setSwitching] = useState<Policy>()
  const { run, error } = useAction()
  const load = useCallback(() => run(async () => setState(await act('rules'))), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const { policy, rules } = state
  const allowCount = rules.filter((r) => r.action === 'allow').length

  const del = (r: Rule) => {
    const what = r.action === 'block' ? 'Agents will be able to run it again' + (policy !== 'allow' ? ' if it is on the allow list.' : '.') : r.action === 'ask' ? 'Matching commands will no longer wait for approval.' : `Agents will no longer be able to run it unless the default is allow${policy === 'ask' ? ' (it will ask)' : ''}.`
    if (window.confirm(`Remove ${r.action} rule for ${r.kind} "${r.value}"${r.host ? ` on ${r.host}` : ''}? ${what}`)) void run(async () => { await act('delete_rule', { id: r.id }); await load() })
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
    if (window.confirm(`Allow by default?\n\nAgents will be able to run any command that isn't blocked.${allowCount ? ` Your ${allowCount} allow rule(s) are kept for when you switch back.` : ''}`))
      void run(async () => { await act('set_policy', { policy: 'allow' }); await load() })
  }

  return (
    <>
      <PendingAsks plugin="ssh" title="Commands waiting for approval" hideEmpty />
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Command rules</h2>
          <div className="row">
            <button className="sm" onClick={() => setDialog({ action: 'block', kind: 'program', value: '' })}>+ Block…</button>
            <button className="sm" onClick={() => setDialog({ action: 'ask', kind: 'program', value: '' })}>+ Ask…</button>
            {policy !== 'allow' && <button className="sm" onClick={() => setDialog({ action: 'allow', kind: 'program', value: '' })}>+ Allow…</button>}
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
          desc="A line with any matching command waits for your approval, even if an allow rule also matches." />
        {(policy !== 'allow' || allowCount > 0) && <RuleGroup title="Allowed" kind="ok" rules={rules.filter((r) => r.action === 'allow')} kinds={KINDS} ops={opsFor('allow')}
          desc={policy !== 'allow' ? 'Every command in a line must match one.' : 'Not in use while the default is allow; kept for when you switch to ask or deny.'} dim={policy === 'allow'} />}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Applies to <code>exec</code> and <code>shell_send</code> on every SSH instance and host, immediately (open shells are kept). Each host's own command patterns are checked after these.
          Commands are found everywhere in the line: pipes, <code>&&</code>, <code>$( )</code>, <code>sudo</code>/<code>xargs</code>/<code>find -exec</code>, and inside <code>sh -c "…"</code> and <code>ssh host "…"</code>.
          Under deny by default a line that can't be fully checked (a program or script built from <code>$VARs</code>, a shell reading stdin or a script file, syntax errors) is refused; under ask by default it waits for your approval.
          Asks block the agent for a short while, then it is told to check back; decide here or on the Approvals page.
          Still a guardrail, not a sandbox: interpreters (<code>python -c</code>, <code>perl -e</code>, <code>node</code>…) and scripts on disk run code that isn't checked, so don't allow them unless you trust what agents run.
        </p>
      </div>
      {policy && <CommandLog state={{ policy, rules }} hosts={hosts} onRule={setDialog} />}
      {dialog && policy && <RuleDialog init={dialog} policy={policy} rules={rules} hosts={hosts} onClose={() => setDialog(undefined)} onDone={async () => { setDialog(undefined); await load() }} />}
      {switching && <DenyDialog to={switching} onClose={() => setSwitching(undefined)} onDone={async () => { setSwitching(undefined); await load() }} />}
    </>
  )
}

/** Switching to ask/deny: offer to allow every program run recently, so nothing that works today silently breaks (or starts asking). */
function DenyDialog({ to, onClose, onDone }: { to: Policy; onClose: () => void; onDone: () => Promise<void> }) {
  const [progs, setProgs] = useState<[string, number][]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { run, busy, error } = useAction()
  useEffect(() => {
    void act<{ programs: [string, number][] }>('deny_candidates').then(({ programs }) => { setProgs(programs); setPicked(new Set(programs.map(([p]) => p))) }).catch(() => setProgs([]))
  }, [])
  const toggle = (p: string) => { const s = new Set(picked); if (s.has(p)) s.delete(p); else s.add(p); setPicked(s) }
  return (
    <Modal title={`Switch to ${to} by default`} onClose={onClose}>
      {to === 'deny'
        ? <p>Agents will only be able to run commands on the allow list. Everything else is refused, and shows as <Badge kind="err">Blocked</Badge> in the command log with an <em>Allow</em> button.</p>
        : <p>Commands on the allow list run; everything else waits for your approval (here and on the Approvals page). Agents are told to check back, then to pause.</p>}
      {error && <Alert kind="err">{error}</Alert>}
      {!progs ? <p className="muted">Checking recent commands…</p> : progs.length === 0 ? <p className="muted small">No recent commands would be affected.</p> : <>
        <p className="small"><strong>Keep these working?</strong> They were run in the last 7 days and aren't on the allow list yet. Ticked programs are added to it, on all hosts. Untick interpreters (python, perl, node…): what they run isn't checked. Allowing a shell (sh, bash) is safer, since the commands inside sh -c are checked too.</p>
        <div className="row small" style={{ gap: 12 }}><a href="#" onClick={(e) => { e.preventDefault(); setPicked(new Set(progs.map(([p]) => p))) }}>Select all</a><a href="#" onClick={(e) => { e.preventDefault(); setPicked(new Set()) }}>Select none</a></div>
        <div style={{ maxHeight: 260, overflow: 'auto', margin: '6px 0' }}>
          {progs.map(([p, n]) => <label key={p} style={{ display: 'block' }}><input type="checkbox" checked={picked.has(p)} onChange={() => toggle(p)} /> <span className="mono">{p}</span> <span className="muted small">{n} time{n === 1 ? '' : 's'}</span></label>)}
        </div>
      </>}
      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !progs} onClick={() => run(async () => { await act('set_policy', { policy: to, allow: [...picked] }); await onDone() })}>
          {to === 'deny' ? 'Deny' : 'Ask'} by default{picked.size ? ` & allow ${picked.size}` : ''}
        </button>
      </div>
    </Modal>
  )
}

/** The rule dialog on its own (Approvals page): loads the default policy itself. `onDone` gets the action saved. */
export function SshRuleDialog({ init, onClose, onDone }: { init: Target; onClose: () => void; onDone: (action: Action) => Promise<void> }) {
  const [st, setSt] = useState<{ policy: Policy; rules: Rule[] }>()
  useEffect(() => { void act<{ policy: Policy; rules: Rule[] }>('rules').then(setSt) }, [])
  return st ? <RuleDialog init={init} policy={st.policy} rules={st.rules} hosts={[]} onClose={onClose} onDone={onDone} /> : null
}

function RuleDialog({ init, policy, rules, hosts, onClose, onDone }: { init: Target; policy: Policy; rules: Rule[]; hosts: string[]; onClose: () => void; onDone: (action: Action) => Promise<void> }) {
  const [action, setAction] = useState(init.action)
  const [kind, setKind] = useState(init.kind)
  const [value, setValue] = useState(init.value)
  const [host, setHost] = useState(init.host ?? '')
  const [note, setNote] = useState('')
  const [pv, setPv] = useState<Preview & { error?: string }>()
  const [keep, setKeep] = useState<Set<number>>(new Set()) // conflicting block rules the admin chose NOT to remove
  const { run, busy, error } = useAction()

  const k = KINDS.find((x) => x.kind === kind)!
  const verb = action === 'block' ? 'Block' : action === 'ask' ? 'Ask' : 'Allow'
  const v = value.trim()
  // Several programs: ticked = has this action. Ones a same-action rule already covers are ticked and locked; the rest start unticked, tick the ones to add.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const typed = kind === 'program' ? [...new Set(v.split(/[\s,]+/).filter(Boolean))] : v ? [v] : []
  const has = (x: string) => rules.some((r) => r.action === action && r.kind === 'program' && r.value === x && (!r.host || r.host === host))
  const values = typed.length > 1 ? typed.filter((x) => picked.has(x) && !has(x)) : typed
  // every program already has this rule but the line still asks: show what else is in the way
  const [why, setWhy] = useState<Why>()
  const allCovered = kind === 'program' && typed.length > 0 && typed.every(has)
  useEffect(() => {
    if (action !== 'allow') return setWhy(undefined)
    if (!allCovered || !init.command) return // keep the explanation after switching to a write rule
    void act<Why>('explain', { command: init.command, host: init.host }).then((w) => {
      setWhy(w)
      // only unallowed writes in the way: switch straight to a write rule for the first one (ponytail: others show up on the next ask)
      if (!w.overriding.length && !w.unknown.length && w.writes.length) { setKind('write'); setValue(dirOf(w.writes[0]!)) }
    }).catch(() => {})
  }, [allCovered, action]) // eslint-disable-line react-hooks/exhaustive-deps
  const delRule = (r: Rule) => run(async () => { await act('delete_rule', { id: r.id }); setWhy(await act<Why>('explain', { command: init.command, host: init.host })) })
  useEffect(() => {
    if (!values.length) return setPv(undefined)
    const t = setTimeout(() => {
      Promise.all(values.map((value) => act<Preview>('preview', { action, kind, value, host, command: init.command })))
        .then((ps) => setPv({ total: ps[0]!.total, hits: Math.max(...ps.map((p) => p.hits)), example: ps.find((p) => p.example)?.example, conflicts: [...new Map(ps.flatMap((p) => p.conflicts).map((r) => [r.id, r])).values()] }))
        .catch((e) => setPv({ total: 0, hits: 0, conflicts: [], error: (e as Error).message }))
    }, 250)
    return () => clearTimeout(t)
  }, [action, kind, v, host, picked]) // eslint-disable-line react-hooks/exhaustive-deps
  const conflicts = pv?.conflicts ?? []
  const remove = conflicts.filter((r) => !keep.has(r.id))
  const kept = conflicts.filter((r) => keep.has(r.id))
  const allowNoop = action === 'allow' && policy === 'allow' && remove.length === 0
  const canSave = !busy && values.length > 0 && !pv?.error && !allowNoop

  const save = () => run(async () => {
    for (const [i, value] of values.entries()) await act('rule', { action, kind, value, host, note, remove: i === 0 ? remove.map((r) => r.id) : [] })
    await onDone(action)
  })

  return (
    <Modal title={`${verb} commands`} onClose={onClose}>
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
        {kind === 'program' && typed.length > 1 && <div className="small" style={{ marginTop: 4 }}>
          <span className="muted">One rule per program, tick the ones to {verb.toLowerCase()}:</span>{' '}
          {typed.map((x) => has(x)
            ? <label key={x} className="toggle mono muted" style={{ marginRight: 8 }} title={`Already a ${action} rule`}><input type="checkbox" checked disabled /> {x}</label>
            : <label key={x} className="toggle mono" style={{ marginRight: 8 }}>
              <input type="checkbox" checked={picked.has(x)} onChange={() => { const s = new Set(picked); if (s.has(x)) s.delete(x); else s.add(x); setPicked(s) }} /> {x}
            </label>)}
        </div>}
        {why && <div className="small" style={{ marginTop: 6 }}>
          <strong>Every program in this line is already allowed.</strong>{' '}
          {!why.verdict.ask && !why.verdict.blocked ? <span className="muted">The line is allowed now; allow this request once.</span> : <>It still {why.verdict.blocked ? 'is blocked' : 'asks'} because:
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {why.overriding.map((r) => <li key={r.id}>{r.action} rule {r.kind}: <span className="mono">{r.value}</span>{r.host && ` @${r.host}`} <button className="sm" disabled={busy} onClick={() => void delRule(r)}>Remove</button></li>)}
            {why.writes.map((f) => <li key={f}>writes <span className="mono">{f}</span> (no allow rule) <button className="sm" onClick={() => { setKind('write'); setValue(dirOf(f)) }}>Allow writes to {dirOf(f)}…</button></li>)}
            {why.unknown.map((u) => <li key={u}>can't be checked: <span className="mono">{u}</span>; allow it once, or allow the whole command <button className="sm" onClick={() => { setKind('prefix'); setValue(init.command!) }}>as a prefix…</button></li>)}
          </ul></>}
        </div>}
        {pv?.error && <div className="err small" style={{ marginTop: 4 }}>{pv.error}</div>}
      </Field>
      <Field label="Hosts">
        <select value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 220 }}>
          <option value="">All hosts</option>{[...new Set([...hosts, ...(init.host ? [init.host] : [])])].map((h) => <option key={h} value={h}>Only {h}</option>)}
        </select>
      </Field>

      {conflicts.length > 0 && <div style={{ margin: '8px 0' }}>
        <p className="small" style={{ margin: '0 0 4px' }}><strong>Rules that override this</strong> <span className="muted">— block wins over ask, ask over allow. Ticked ones are removed:</span></p>
        {conflicts.map((r) => <label key={r.id} style={{ display: 'block' }} className="small">
          <input type="checkbox" checked={!keep.has(r.id)} onChange={() => { const s = new Set(keep); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setKeep(s) }} /> {r.action} {r.kind}: <span className="mono">{r.value}</span>{r.host && ` @${r.host}`}
        </label>)}
      </div>}

      {action !== 'allow' || policy !== 'allow' ? <Field label="Note (optional)"><input type="text" placeholder={`Why is this ${action === 'block' ? 'blocked' : action === 'ask' ? 'asked' : 'allowed'}?`} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} /></Field> : null}

      {pv && !pv.error && <div className="small" style={{ margin: '8px 0' }}>
        <div>{pv.hits ? <>Matches <strong>{pv.hits}</strong> of {pv.total} commands in the last 7 days, e.g. <span className="mono">{pv.example}</span></> : <span className="muted">Matches none of the {pv.total} commands in the last 7 days.</span>}</div>
        <div style={{ marginTop: 4 }}>
          {action === 'block' && `Adds ${values.length > 1 ? `${values.length} block rules` : 'a block rule'}. Matching commands are refused whatever the default policy is.`}
          {action === 'ask' && `Adds ${values.length > 1 ? `${values.length} ask rules` : 'an ask rule'}. A line with a matching command waits for your approval.`}
          {action === 'allow' && policy !== 'allow' && `Adds ${values.length > 1 ? `${values.length} allow rules` : 'an allow rule'}. A command line runs only if every command in it is allowed.`}
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

function CommandLog({ state, hosts, onRule }: { state: { policy: Policy; rules: Rule[] }; hosts: string[]; onRule: (t: Target) => void }) {
  const [servers] = useApi<Server[]>('/servers')
  const [range, setRange] = useState<number | 'custom'>(86400e3)
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 86400e3))
  const [to, setTo] = useState(() => toLocalInput(Date.now()))
  const [f, setF] = useState({ q: '', host: '', tool: '', outcome: '', server: '' })
  const [live, setLive] = useState(true)
  const [data, setData] = useState<{ rows: Cmd[]; more: boolean }>()
  const { run, error, busy } = useAction()
  const load = useCallback(() => run(async () => {
    const [since, until] = range === 'custom' ? [new Date(from).getTime(), new Date(to).getTime()] : [Date.now() - range, Date.now()]
    setData(await act('commands', { since, until, ...f }))
  }), [range, from, to, f, state]) // eslint-disable-line react-hooks/exhaustive-deps
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
        <h2 style={{ margin: 0 }}>Command log <span className="muted small">({rows.length}{data?.more ? '+' : ''})</span></h2>
        <div className="row">
          {range !== 'custom' && <label className="toggle small"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Auto-refresh</label>}
          <button className="sm" onClick={load} disabled={busy}>Refresh</button>
          <button className="sm danger" onClick={() => { if (window.confirm('Delete the whole command log?')) void run(async () => { await act('clear_commands'); await load() }) }}>Clear log</button>
        </div>
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        <select value={String(range)} onChange={(e) => setRange(e.target.value === 'custom' ? 'custom' : Number(e.target.value))} style={{ width: 160 }}>
          {RANGES.map(([l, ms]) => <option key={ms} value={ms}>{l}</option>)}<option value="custom">Custom range…</option>
        </select>
        {range === 'custom' && <><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /> <span className="muted">to</span> <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></>}
        <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} style={{ width: 130 }}><option value="">Allowed & blocked</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option><option value="error">Errors</option></select>
        <select value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} style={{ width: 140 }}><option value="">All hosts</option>{hosts.map((h) => <option key={h}>{h}</option>)}</select>
        <select value={f.tool} onChange={(e) => setF({ ...f, tool: e.target.value })} style={{ width: 120 }}><option value="">All tools</option><option value="exec">exec</option><option value="shell">shell</option><option value="sftp">sftp</option></select>
        <select value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} style={{ width: 160 }}><option value="">All servers</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input type="text" placeholder="Search command or agent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 220 }} />
      </div>
      {error && <Alert kind="err">{error}</Alert>}
      <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Time</th><th>Server / agent</th><th>Host</th><th>Tool</th><th>Command</th><th>Access</th><th>Result</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const cmd = isCmd(r.tool)
            const stopped = r.now_blocked || r.now_ask
            const changed = cmd && (r.now_blocked !== (!!r.blocked && !asked(r.blocked)) || !!r.now_ask !== asked(r.blocked))
            const next: Action = stopped ? 'allow' : 'block'
            const Verb = stopped ? 'Allow' : 'Block'
            const progs = r.programs ?? []
            return <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{sname(r.server_id)}{r.instance !== 'ssh' ? `/${r.instance}` : ''}<div className="muted">{r.principal ?? '—'}</div></td>
              <td className="small">{r.host}</td>
              <td><Badge kind={r.tool === 'sftp_write' ? 'warn' : r.tool.startsWith('sftp') ? 'info' : undefined}>{r.tool}</Badge></td>
              <td className="mono" style={{ width: '100%', minWidth: 360 }} title={r.command}><div style={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.command}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {asked(r.blocked) ? <Badge kind="warn">Asked</Badge> : r.blocked ? <Badge kind="err">Blocked</Badge> : <Badge kind="ok">Allowed</Badge>}
                <span className="muted small"> {ruleText(r.blocked ?? r.allowed_by)}</span>
                {changed && <div className="small" style={{ fontStyle: 'italic' }}>now {r.now_blocked ? 'blocked' : r.now_ask ? 'asks' : 'allowed'}</div>}
                {!!r.writes?.length && <div className="muted small" title={r.writes.join('\n')}>writes {r.writes.join(', ').slice(0, 40)}</div>}
                {!!r.unknown?.length && <div className="small" style={{ color: "var(--warn)" }} title={r.unknown.join('\n')}>can't fully check</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked || (r.tool === 'shell' && !r.error) ? <span className="muted small">—</span> : r.error ? <><Badge kind="err">failed</Badge> <span className="muted small" title={r.error}>{r.error.slice(0, 40)}</span></>
                  : r.exit_code == null ? <span className="muted small">ok</span>
                  : <><Badge kind={r.exit_code ? 'err' : undefined}>exit {r.exit_code}</Badge>{r.ms != null && <span className="muted small"> {r.ms} ms</span>}</>}
              </td>
              <td>{cmd && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, whiteSpace: 'nowrap' }}>
                {progs.length > 0 && <button className={`sm${stopped ? '' : ' danger'}`} title={`${Verb} ${progs.join(', ')}`} onClick={() => onRule({ action: next, kind: 'program', value: progs.join(' '), host: r.host, command: r.command })}>{Verb} program{progs.length > 1 ? 's' : ''}</button>}
                {r.single && <button className={`sm${stopped ? '' : ' danger'}`} title={`${Verb} this exact command`} onClick={() => onRule({ action: next, kind: 'prefix', value: r.single!, host: r.host, command: r.command })}>{Verb} command</button>}
                {!!r.writes?.length && <button className={`sm${stopped ? '' : ' danger'}`} title={`${Verb} writing into ${dirOf(r.writes[0]!)}`} onClick={() => onRule({ action: next, kind: 'write', value: dirOf(r.writes![0]!), host: r.host, command: r.command })}>{Verb} writes</button>}
              </div>}</td>
            </tr>
          })}
          {rows.length === 0 && (data ? <tr><td colSpan={8} className="muted">No commands in this timeframe.</td></tr> : <LoadingRow cols={8} />)}
        </tbody>
      </table>
      </div>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older commands.</p>}
    </div>
  )
}
