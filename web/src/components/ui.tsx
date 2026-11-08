import { useState } from 'react'
import { copy } from '../api'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="row between" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="sm" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{desc && <div className="desc">{desc}</div>}</div>
}

export function Badge({ kind, children }: { kind?: 'ok' | 'err' | 'warn' | 'info'; children: React.ReactNode }) {
  return <span className={`badge ${kind ?? ''}`}>{children}</span>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return <button className="sm" onClick={() => { void copy(text); setDone(true); setTimeout(() => setDone(false), 1200) }}>{done ? 'Copied' : label}</button>
}

export function Alert({ kind, children }: { kind: 'ok' | 'err'; children: React.ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>
}

/** Run an async action with error capture. */
export function useAction() {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return { run, error, busy, setError }
}

/** Table body row shown while a table's data hasn't arrived yet. */
export function LoadingRow({ cols }: { cols: number }) {
  // shimmering placeholder rows; the delay staggers a diagonal wave across cells
  return <>{[0, 1, 2].map((r) => <tr key={r} className="skel-row" aria-busy={r === 0 || undefined}>
    {Array.from({ length: cols }, (_, c) => <td key={c}>
      <span className="skel" style={{ width: `${45 + ((r * 7 + c * 13) % 5) * 11}%`, animationDelay: `${(r + c) * 0.08}s` }}>{r === 0 && c === 0 && <span className="sr-only">Loading…</span>}</span>
    </td>)}
  </tr>)}</>
}

export function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>
}
