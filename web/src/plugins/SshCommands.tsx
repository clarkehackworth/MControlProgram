import { useCallback, useEffect, useState } from 'react'
import { api, useApi, type Server } from '../api'
import { Alert, Badge, Field, Modal, useAction } from '../components/ui'

type Kind = 'program' | 'prefix' | 'regex' | 'write'
type Action = 'block' | 'allow'
type Policy = 'allow' | 'deny'
interface Rule { id: number; action: Action; kind: Kind; value: string; host: string; note: string; created_at: number }
interface Cmd { id: number; ts: number; server_id: string; instance: string; principal: string | null; host: string; tool: string; command: string; exit_code: number | null; error: string | null; blocked: string | null; allowed_by: string | null; ms: number | null; now_blocked?: boolean; programs?: string[]; single?: string; writes?: string[]; unknown?: string[] }
interface Target { action: Action; kind: Kind; value: string; host?: string; command?: string }
interface Preview { total: number; hits: number; example?: string; conflicts: Rule[] }

const act = <T,>(key: string, body: Record<string, unknown> = {}) => api<{ result: T }>(`/plugins/ssh/actions/${key}`, { method: 'POST', body }).then((r) => r.result)

const KINDS: { kind: Kind; title: string; label: string; help: string; placeholder: string }[] = [
  { kind: 'program', title: 'Programs', label: 'Program', help: 'A program name, wherever it runs in the command line: after ; && | $( … and behind sudo, env, xargs and similar. Several names separated by spaces add one rule each.', placeholder: 'rm' },
  { kind: 'prefix', title: 'Commands', label: 'Command prefix', help: 'Each command in the line that starts with this, in whole words ("git status" matches "git status -s", not "git statusx").', placeholder: 'git status' },
  { kind: 'regex', title: 'Patterns', label: 'Pattern (regex)', help: 'Regular expression tested against each command in the line (block rules also test the whole line). Case-sensitive.', placeholder: '^systemctl (status|restart) ' },
  { kind: 'write', title: 'Written files', label: 'Write to (path)', help: 'Output redirects (>, >>, &>) into this file or directory. "/tmp" covers /tmp/x but not /tmpfoo. /dev/null is always allowed. Only redirects: programs that write files themselves (cp, tee, sed -i…) are controlled by program rules.', placeholder: '/tmp' },
]
const RANGES: [string, number][] = [['Last 15 minutes', 15 * 60e3], ['Last hour', 3600e3], ['Last 24 hours', 86400e3], ['Last 7 days', 7 * 86400e3], ['Last 30 days', 30 * 86400e3]]
const ruleText = (s: string | null) => s === 'default: deny' ? 'not on allow list' : s === 'default: allow' ? 'allowed by default' : s ?? ''
const fmt = (ts: number) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString() }
const toLocalInput = (ts: number) => new Date(ts - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)
const isCmd = (t: string) => t === 'exec' || t === 'shell'
const dirOf = (f: string) => f.includes('/') ? f.replace(/\/[^/]*$/, '') || '/' : f

/** SSH plugin: admin command rules (default policy + block/allow by program, command prefix, regex; optionally per host) and the log of what agents ran. */
export default function SshCommands({ hosts }: { hosts: string[] }) {
  const [state, setState] = useState<{ policy: Policy; rules: Rule[] }>({ policy: 'allow', rules: [] })
  const [dialog, setDialog] = useState<Target>()
  const [switching, setSwitching] = useState(false)
  const { run, error } = useAction()
  const load = useCallback(() => run(async () => setState(await act('rules'))), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const { policy, rules } = state
  const allowCount = rules.filter((r) => r.action === 'allow').length

  const del = (r: Rule) => {
    const what = r.action === 'block' ? 'Agents will be able to run it again' + (policy === 'deny' ? ' if it is on the allow list.' : '.') : 'Agents will no longer be able to run it unless the default is allow.'
    if (window.confirm(`Remove ${r.action} rule for ${r.kind} "${r.value}"${r.host ? ` on ${r.host}` : ''}? ${what}`)) void run(async () => { await act('delete_rule', { id: r.id }); await load() })
  }
  const toAllow = () => {
    if (window.confirm(`Allow by default?\n\nAgents will be able to run any command that isn't blocked.${allowCount ? ` Your ${allowCount} allow rule(s) are kept for when you switch back.` : ''}`))
      void run(async () => { await act('set_policy', { policy: 'allow' }); await load() })
  }

  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Command rules</h2>
          <div className="row">
            <button className="sm" onClick={() => setDialog({ action: 'block', kind: 'program', value: '' })}>+ Block…</button>
            {policy === 'deny' && <button className="sm" onClick={() => setDialog({ action: 'allow', kind: 'program', value: '' })}>+ Allow…</button>}
          </div>
        </div>
        {error && <Alert kind="err">{error}</Alert>}

        <div className="row" style={{ margin: '12px 0', gap: 8, alignItems: 'stretch' }} role="radiogroup" aria-label="Default policy">
          {([['allow', 'Allow by default', 'Agents can run any command except blocked ones.'], ['deny', 'Deny by default', 'Agents can run only allowed commands. Blocked ones stay blocked.']] as const).map(([p, t, d]) =>
            <button key={p} role="radio" aria-checked={policy === p} className={policy === p ? 'primary' : ''} style={{ flex: 1, textAlign: 'left', padding: '8px 12px' }}
              onClick={() => policy !== p && (p === 'deny' ? setSwitching(true) : toAllow())}>
              <strong>{policy === p ? '● ' : '○ '}{t}</strong><div className="small" style={{ opacity: 0.8 }}>{d}</div>
            </button>)}
        </div>

        <RuleGroup title="Blocked" kind="err" rules={rules.filter((r) => r.action === 'block')} onDelete={del}
          desc="Always refused, even if an allow rule also matches." />
        {(policy === 'deny' || allowCount > 0) && <RuleGroup title="Allowed" kind="ok" rules={rules.filter((r) => r.action === 'allow')} onDelete={del}
          desc={policy === 'deny' ? 'Every command in a line must match one.' : 'Not in use while the default is allow; kept for when you switch to deny.'} dim={policy !== 'deny'} />}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Applies to <code>exec</code> and <code>shell_send</code> on every SSH instance and host, immediately (open shells are kept). Each host's own command patterns are checked after these.
          Commands are found everywhere in the line: pipes, <code>&&</code>, <code>$( )</code>, <code>sudo</code>/<code>xargs</code>/<code>find -exec</code>, and inside <code>sh -c "…"</code> and <code>ssh host "…"</code>.
          Under deny by default a line that can't be fully checked (a program or script built from <code>$VARs</code>, a shell reading stdin or a script file, syntax errors) is refused.
          Still a guardrail, not a sandbox: interpreters (<code>python -c</code>, <code>perl -e</code>, <code>node</code>…) and scripts on disk run code that isn't checked, so don't allow them unless you trust what agents run.
        </p>
      </div>
      <CommandLog state={state} hosts={hosts} onRule={setDialog} />
      {dialog && <RuleDialog init={dialog} policy={policy} hosts={hosts} onClose={() => setDialog(undefined)} onDone={async () => { setDialog(undefined); await load() }} />}
      {switching && <DenyDialog onClose={() => setSwitching(false)} onDone={async () => { setSwitching(false); await load() }} />}
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
                {r.value}{r.host && <span className="muted"> @{r.host}</span>}<button title="Remove" aria-label={`Remove ${title.toLowerCase()} ${r.value}`} onClick={() => onDelete(r)}>✕</button>
              </span>)}
              {list.length === 0 && <span className="muted small">None</span>}
            </div>
          </div>
        })}
      </div>
    </div>
  )
}

/** Switching to deny: offer to allow every program run recently, so nothing that works today silently breaks. */
function DenyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [progs, setProgs] = useState<[string, number][]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { run, busy, error } = useAction()
  useEffect(() => {
    void act<{ programs: [string, number][] }>('deny_candidates').then(({ programs }) => { setProgs(programs); setPicked(new Set(programs.map(([p]) => p))) }).catch(() => setProgs([]))
  }, [])
  const toggle = (p: string) => { const s = new Set(picked); if (s.has(p)) s.delete(p); else s.add(p); setPicked(s) }
  return (
    <Modal title="Switch to deny by default" onClose={onClose}>
      <p>Agents will only be able to run commands on the allow list. Everything else is refused, and shows as <Badge kind="err">Blocked</Badge> in the command log with an <em>Allow</em> button.</p>
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
        <button className="primary" disabled={busy || !progs} onClick={() => run(async () => { await act('set_policy', { policy: 'deny', allow: [...picked] }); await onDone() })}>
          Deny by default{picked.size ? ` & allow ${picked.size}` : ''}
        </button>
      </div>
    </Modal>
  )
}

function RuleDialog({ init, policy, hosts, onClose, onDone }: { init: Target; policy: Policy; hosts: string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [action, setAction] = useState(init.action)
  const [kind, setKind] = useState(init.kind)
  const [value, setValue] = useState(init.value)
  const [host, setHost] = useState(init.host ?? '')
  const [note, setNote] = useState('')
  const [pv, setPv] = useState<Preview & { error?: string }>()
  const [keep, setKeep] = useState<Set<number>>(new Set()) // conflicting block rules the admin chose NOT to remove
  const { run, busy, error } = useAction()

  const k = KINDS.find((x) => x.kind === kind)!
  const v = value.trim()
  const values = kind === 'program' ? [...new Set(v.split(/[\s,]+/).filter(Boolean))] : v ? [v] : []
  useEffect(() => {
    if (!values.length) return setPv(undefined)
    const t = setTimeout(() => {
      Promise.all(values.map((value) => act<Preview>('preview', { action, kind, value, host, command: init.command })))
        .then((ps) => setPv({ total: ps[0]!.total, hits: Math.max(...ps.map((p) => p.hits)), example: ps.find((p) => p.example)?.example, conflicts: [...new Map(ps.flatMap((p) => p.conflicts).map((r) => [r.id, r])).values()] }))
        .catch((e) => setPv({ total: 0, hits: 0, conflicts: [], error: (e as Error).message }))
    }, 250)
    return () => clearTimeout(t)
  }, [action, kind, v, host]) // eslint-disable-line react-hooks/exhaustive-deps
  const conflicts = pv?.conflicts ?? []
  const remove = conflicts.filter((r) => !keep.has(r.id))
  const kept = conflicts.filter((r) => keep.has(r.id))
  const allowNoop = action === 'allow' && policy === 'allow' && remove.length === 0
  const canSave = !busy && values.length > 0 && !pv?.error && !allowNoop

  const save = () => run(async () => {
    for (const [i, value] of values.entries()) await act('rule', { action, kind, value, host, note, remove: i === 0 ? remove.map((r) => r.id) : [] })
    await onDone()
  })
  const verb = action === 'block' ? 'Block' : 'Allow'

  return (
    <Modal title={action === 'block' ? 'Block commands' : 'Allow commands'} onClose={onClose}>
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
        {pv?.error && <div className="err small" style={{ marginTop: 4 }}>{pv.error}</div>}
      </Field>
      <Field label="Hosts">
        <select value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 220 }}>
          <option value="">All hosts</option>{[...new Set([...hosts, ...(init.host ? [init.host] : [])])].map((h) => <option key={h} value={h}>Only {h}</option>)}
        </select>
      </Field>

      {conflicts.length > 0 && <div style={{ margin: '8px 0' }}>
        <p className="small" style={{ margin: '0 0 4px' }}><strong>Block rules that cover this</strong> <span className="muted">— block rules win over allow rules. Ticked ones are removed:</span></p>
        {conflicts.map((r) => <label key={r.id} style={{ display: 'block' }} className="small">
          <input type="checkbox" checked={!keep.has(r.id)} onChange={() => { const s = new Set(keep); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setKeep(s) }} /> {r.kind}: <span className="mono">{r.value}</span>{r.host && ` @${r.host}`}
        </label>)}
      </div>}

      {action === 'block' || policy === 'deny' ? <Field label="Note (optional)"><input type="text" placeholder={`Why is this ${action === 'block' ? 'blocked' : 'allowed'}?`} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} /></Field> : null}

      {pv && !pv.error && <div className="small" style={{ margin: '8px 0' }}>
        <div>{pv.hits ? <>Matches <strong>{pv.hits}</strong> of {pv.total} commands in the last 7 days, e.g. <span className="mono">{pv.example}</span></> : <span className="muted">Matches none of the {pv.total} commands in the last 7 days.</span>}</div>
        <div style={{ marginTop: 4 }}>
          {action === 'block' && `Adds ${values.length > 1 ? `${values.length} block rules` : 'a block rule'}. Matching commands are refused whatever the default policy is.`}
          {action === 'allow' && policy === 'deny' && `Adds ${values.length > 1 ? `${values.length} allow rules` : 'an allow rule'}. A command line runs only if every command in it is allowed.`}
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
            const changed = cmd && r.now_blocked !== !!r.blocked
            const next: Action = r.now_blocked ? 'allow' : 'block'
            const Verb = r.now_blocked ? 'Allow' : 'Block'
            const progs = r.programs ?? []
            return <tr key={r.id} className="log-row">
              <td className="ts">{fmt(r.ts)}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{sname(r.server_id)}{r.instance !== 'ssh' ? `/${r.instance}` : ''}<div className="muted">{r.principal ?? '—'}</div></td>
              <td className="small">{r.host}</td>
              <td><Badge kind={r.tool === 'sftp_write' ? 'warn' : r.tool.startsWith('sftp') ? 'info' : undefined}>{r.tool}</Badge></td>
              <td className="mono" style={{ width: '100%', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.command}>{r.command}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked ? <Badge kind="err">Blocked</Badge> : <Badge kind="ok">Allowed</Badge>}
                <span className="muted small"> {ruleText(r.blocked ?? r.allowed_by)}</span>
                {changed && <div className="small" style={{ fontStyle: 'italic' }}>now {r.now_blocked ? 'blocked' : 'allowed'}</div>}
                {!!r.writes?.length && <div className="muted small" title={r.writes.join('\n')}>writes {r.writes.join(', ').slice(0, 40)}</div>}
                {!!r.unknown?.length && <div className="small" style={{ color: "var(--warn)" }} title={r.unknown.join('\n')}>can't fully check</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.blocked || (r.tool === 'shell' && !r.error) ? <span className="muted small">—</span> : r.error ? <><Badge kind="err">failed</Badge> <span className="muted small" title={r.error}>{r.error.slice(0, 40)}</span></>
                  : r.exit_code == null ? <span className="muted small">ok</span>
                  : <><Badge kind={r.exit_code ? 'err' : undefined}>exit {r.exit_code}</Badge>{r.ms != null && <span className="muted small"> {r.ms} ms</span>}</>}
              </td>
              <td>{cmd && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, whiteSpace: 'nowrap' }}>
                {progs.length > 0 && <button className={`sm${r.now_blocked ? '' : ' danger'}`} title={`${Verb} ${progs.join(', ')}`} onClick={() => onRule({ action: next, kind: 'program', value: progs.join(' '), host: r.host, command: r.command })}>{Verb} program{progs.length > 1 ? 's' : ''}</button>}
                {r.single && <button className={`sm${r.now_blocked ? '' : ' danger'}`} title={`${Verb} this exact command`} onClick={() => onRule({ action: next, kind: 'prefix', value: r.single!, host: r.host, command: r.command })}>{Verb} command</button>}
                {!!r.writes?.length && <button className={`sm${r.now_blocked ? '' : ' danger'}`} title={`${Verb} writing into ${dirOf(r.writes[0]!)}`} onClick={() => onRule({ action: next, kind: 'write', value: dirOf(r.writes![0]!), host: r.host, command: r.command })}>{Verb} writes</button>}
              </div>}</td>
            </tr>
          })}
          {rows.length === 0 && <tr><td colSpan={8} className="muted">{data ? 'No commands in this timeframe.' : 'Loading…'}</td></tr>}
        </tbody>
      </table>
      </div>
      {data?.more && <p className="muted small">Showing the newest {rows.length}. Narrow the timeframe or filters to see older commands.</p>}
    </div>
  )
}
