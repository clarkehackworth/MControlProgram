import { useMemo, useState } from 'react'
import { Alert, Badge, Modal, useAction } from './ui'

export type RuleAction = 'block' | 'ask' | 'allow'
export interface GroupRule { id: number; action: RuleAction; kind: string; value: string; note: string; created_at: number; host?: string }
export interface RuleOps<R extends GroupRule> {
  /** Single remove from a chip (the panel confirms with its own wording). */
  onDelete: (r: R) => void
  /** Bulk remove from the Manage dialog (already confirmed). */
  remove: (ids: number[]) => Promise<void>
  /** Change a rule's action (block / ask / allow). */
  move: (r: R, action: RuleAction) => Promise<void>
  /** Open the panel's add-rule dialog for this action and kind. */
  add: (kind: string) => void
}

/** Chips shown per kind before "+N more"; the rest are in Manage. */
const CHIPS = 8
const ACTIONS: [RuleAction, string][] = [['block', 'Block'], ['ask', 'Ask'], ['allow', 'Allow']]
const fmt = (ts: number) => new Date(ts).toLocaleString()

/** One action's rules (e.g. Blocked) as chips by kind, newest first, capped, with a Manage dialog for all of them. */
export function RuleGroup<R extends GroupRule>({ title, kind, rules, desc, dim, kinds, ops }:
  { title: string; kind: 'ok' | 'err' | 'warn'; rules: R[]; desc: string; dim?: boolean; kinds: { kind: string; title: string }[]; ops: RuleOps<R> }) {
  const [manage, setManage] = useState<string>() // kind filter; undefined = closed
  const newest = useMemo(() => [...rules].sort((a, b) => b.created_at - a.created_at), [rules])
  return (
    <div style={{ marginTop: 12 }}>
      {/* opacity on the content only: on the wrapper it would also dim the Manage dialog */}
      <div style={{ opacity: dim ? 0.6 : 1 }}>
      <div><Badge kind={kind}>{title}</Badge> <span className="muted small">({rules.length}) — {desc}</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 6 }}>
        {kinds.map((k) => {
          const list = newest.filter((r) => r.kind === k.kind)
          return <div key={k.kind}>
            <strong className="small">{k.title}</strong>
            <div className="chips" style={{ marginTop: 4 }}>
              {list.slice(0, CHIPS).map((r) => <span key={r.id} className="chip mono" title={`${r.note ? r.note + ' — ' : ''}added ${fmt(r.created_at)}`}>
                {r.value}{r.host && <span className="muted"> @{r.host}</span>}<button title="Remove" aria-label={`Remove ${title.toLowerCase()} ${r.value}`} onClick={() => ops.onDelete(r)}>✕</button>
              </span>)}
              {list.length > CHIPS && <button className="sm" onClick={() => setManage(k.kind)} title={`Manage all ${title.toLowerCase()} ${k.title.toLowerCase()}`}>+{list.length - CHIPS} more…</button>}
              {list.length === 0 && <span className="muted small">None</span>}
            </div>
          </div>
        })}
      </div>
      </div>
      {manage !== undefined && <ManageRules title={title} rules={newest} kinds={kinds} ops={ops} initialKind={manage} onClose={() => setManage(undefined)} />}
    </div>
  )
}

/** Every rule of one action in a table: search, filter by kind, change action, bulk remove, add. */
function ManageRules<R extends GroupRule>({ title, rules, kinds, ops, initialKind, onClose }:
  { title: string; rules: R[]; kinds: { kind: string; title: string }[]; ops: RuleOps<R>; initialKind: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState(initialKind)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const { run, busy, error } = useAction()
  const hosts = rules.some((r) => r.host !== undefined)
  const kindTitle = (k: string) => kinds.find((x) => x.kind === k)?.title ?? k
  const ql = q.trim().toLowerCase()
  const shown = rules.filter((r) => (!kind || r.kind === kind) && (!ql || [r.value, r.note, r.host ?? ''].some((s) => s.toLowerCase().includes(ql))))
  const shownPicked = shown.filter((r) => picked.has(r.id))
  const allPicked = shown.length > 0 && shownPicked.length === shown.length
  const toggle = (id: number) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s) }
  const removePicked = () => {
    if (!window.confirm(`Remove ${shownPicked.length} ${title.toLowerCase()} rule${shownPicked.length === 1 ? '' : 's'}?`)) return
    void run(async () => { await ops.remove(shownPicked.map((r) => r.id)); setPicked(new Set()) })
  }

  return (
    <Modal title={`${title} rules`} onClose={onClose}>
      {error && <Alert kind="err">{error}</Alert>}
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input type="search" placeholder={`Search value, note${hosts ? ', host' : ''}…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, width: 'auto' }} autoFocus />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All kinds</option>{kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
        </select>
        <button className="sm primary" style={{ whiteSpace: 'nowrap' }} onClick={() => ops.add(kind || kinds[0]!.kind)}>+ Add…</button>
      </div>
      <div className="row between small" style={{ margin: '8px 0' }}>
        <span className="muted">{shown.length} of {rules.length}</span>
        <button className="sm danger" disabled={busy || !shownPicked.length} onClick={removePicked}>Remove selected ({shownPicked.length})</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            <th><input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={() => setPicked(allPicked ? new Set([...picked].filter((id) => !shown.some((r) => r.id === id))) : new Set([...picked, ...shown.map((r) => r.id)]))} /></th>
            <th>Kind</th><th>Value</th>{hosts && <th>Host</th>}<th>Note</th><th>Added</th><th>Action</th><th></th>
          </tr></thead>
          <tbody>
            {shown.map((r) => <tr key={r.id}>
              <td><input type="checkbox" aria-label={`Select ${r.value}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
              <td className="small">{kindTitle(r.kind)}</td>
              <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{r.value}</td>
              {hosts && <td className="small">{r.host || <span className="muted">all</span>}</td>}
              <td className="small">{r.note}</td>
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</td>
              <td><select aria-label={`Action for ${r.value}`} value={r.action} disabled={busy} onChange={(e) => void run(() => ops.move(r, e.target.value as RuleAction))} style={{ width: 'auto' }}>
                {ACTIONS.map(([a, l]) => <option key={a} value={a}>{l}</option>)}
              </select></td>
              <td><button className="sm" disabled={busy} title="Remove" aria-label={`Remove ${r.value}`} onClick={() => ops.onDelete(r)}>✕</button></td>
            </tr>)}
            {shown.length === 0 && <tr><td colSpan={8} className="muted">{rules.length ? 'Nothing matches.' : 'No rules yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
