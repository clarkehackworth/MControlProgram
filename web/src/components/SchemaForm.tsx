import { useState } from 'react'

type Schema = Record<string, any>

/** Build a value conforming to the schema's defaults. */
export function defaultsFor(schema: Schema | undefined): any {
  if (!schema) return undefined
  if (schema.default !== undefined) return structuredClone(schema.default)
  switch (schema.type) {
    case 'object': {
      const o: Record<string, any> = {}
      for (const [k, s] of Object.entries<Schema>(schema.properties ?? {})) { const v = defaultsFor(s); if (v !== undefined) o[k] = v }
      return o
    }
    case 'array': return []
    case 'boolean': return false
    case 'string': return schema.enum?.[0] ?? ''
    default: return undefined
  }
}

interface Props { schema: Schema; value: any; onChange: (v: any) => void; path?: string; options?: Record<string, any>; parent?: Record<string, any>; setParent?: (patch: Record<string, any>) => void }

/** `options`: plugin-wide config used to resolve `x-options-from` (names of an array in that config). */
export default function SchemaForm({ schema, value, onChange, path = '', options, parent, setParent }: Props) {
  const t = schema.type
  const title = schema.title ?? path.split('.').pop() ?? ''
  const optionsFrom = (sch: Schema): string[] | undefined => sch['x-options-from'] ? ((options?.[sch['x-options-from']] as any[]) ?? []).map((o) => (typeof o === 'string' ? o : o?.name)).filter(Boolean) : undefined
  const desc = schema.description

  if (schema['x-secret']) return <Field title={title} desc={desc}><SecretInput value={value ?? ''} onChange={onChange} /></Field>

  if (t === 'boolean') return (
    <div className="field"><label className="check"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {title}</label>{desc && <div className="desc">{desc}</div>}</div>
  )

  if (t === 'string') {
    const opts = schema.enum ?? optionsFrom(schema)
    if (opts) return <Field title={title} desc={desc}><select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>{!schema.enum && <option value="">—</option>}{opts.map((o: string) => <option key={o} value={o}>{o}</option>)}</select></Field>
    if (schema.format === 'multiline') return <Field title={title} desc={desc}><textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>
    return <Field title={title} desc={desc}><input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>
  }

  if (t === 'integer' || t === 'number') return (
    <Field title={title} desc={desc}><input type="number" step={t === 'integer' ? 1 : 'any'} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></Field>
  )

  if (t === 'array') {
    const items: Schema = schema.items ?? { type: 'string' }
    const arr: any[] = Array.isArray(value) ? value : []
    const set = (i: number, v: any) => onChange(arr.map((x, j) => (j === i ? v : x)))
    const del = (i: number) => onChange(arr.filter((_, j) => j !== i))
    const move = (i: number, d: number) => { const n = [...arr]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n) }
    if (items.type === 'object') return (
      <fieldset><legend>{title}</legend>
        {desc && <div className="desc muted small" style={{ marginBottom: 8 }}>{desc}</div>}
        {arr.map((v, i) => (
          <Entry key={i} title={v?.name || `#${i + 1}`} sub={v?.host ?? v?.url ?? v?.command} startOpen={!v?.name}
            actions={<>
              <button className="sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="sm" disabled={i === arr.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="sm danger" onClick={() => del(i)}>Remove</button>
            </>}>
            <SchemaForm schema={items} value={v} onChange={(nv) => set(i, nv)} path={`${path}.${i}`} options={options} />
          </Entry>
        ))}
        <button className="sm" onClick={() => onChange([...arr, defaultsFor(items) ?? {}])}>+ Add</button>
      </fieldset>
    )
    const fromOpts = optionsFrom(items)
    // legacy configs may hold non-string entries (e.g. inline credential objects); drop them rather than crash
    if (fromOpts) {
      // chosen + disabled lists live in sibling keys; update both in one patch so neither clobbers the other
      const dk: string | undefined = schema['x-disabled-key'] && parent && setParent ? schema['x-disabled-key'] : undefined
      return <Picker title={title} desc={desc} all={fromOpts} chosen={(arr as any[]).filter((x): x is string => typeof x === 'string')}
        disabled={dk ? parent![dk] ?? [] : undefined}
        onChange={(c, d) => (dk ? setParent!({ [path.split('.').pop()!]: c, [dk]: d }) : onChange(c))} />
    }
    // array of scalars: line editor
    return (
      <Field title={title} desc={desc}>
        <div className="stack">
          {arr.map((v, i) => (
            <div className="row" key={i}>
              {items.enum
                ? <select value={v ?? ''} onChange={(e) => set(i, e.target.value)} style={{ flex: 1 }}>{items.enum.map((o: string) => <option key={o}>{o}</option>)}</select>
                : <input type="text" value={v ?? ''} onChange={(e) => set(i, e.target.value)} style={{ flex: 1 }} />}
              <button className="sm danger" onClick={() => del(i)}>✕</button>
            </div>
          ))}
          <div><button className="sm" onClick={() => onChange([...arr, items.enum?.[0] ?? ''])}>+ Add</button></div>
        </div>
      </Field>
    )
  }

  if (t === 'object') {
    const obj = value && typeof value === 'object' ? value : {}
    const props = Object.entries<Schema>(schema.properties ?? {})
    const setK = (k: string, v: any) => onChange({ ...obj, [k]: v })
    const ap = schema.additionalProperties
    const extraKeys = ap && typeof ap === 'object' ? Object.keys(obj).filter((k) => !schema.properties?.[k]) : []
    const body = (
      <>
        {props.filter(([, s]) => !s['x-hidden']).filter(([, s]) => !s['x-show-if'] || Object.entries(s['x-show-if']).every(([dk, dv]) => (Array.isArray(dv) ? dv.includes(obj[dk]) : obj[dk] === dv)))
          .map(([k, s]) => <SchemaForm key={k} schema={s} value={obj[k]} onChange={(v) => setK(k, v)} path={path ? `${path}.${k}` : k} options={options} parent={obj} setParent={(patch) => onChange({ ...obj, ...patch })} />)}
        {ap && typeof ap === 'object' && <KeyValues keys={extraKeys} obj={obj} onChange={onChange} />}
      </>
    )
    return path ? body : <div>{desc && <p className="muted small">{desc}</p>}{body}</div>
  }

  return <Field title={title} desc={desc}><textarea value={JSON.stringify(value ?? null)} onChange={(e) => { try { onChange(JSON.parse(e.target.value)) } catch { /* keep typing */ } }} /></Field>
}

/** Searchable list of available names; chosen ones are listed below with an enable checkbox and a remove button. */
function Picker({ title, desc, all, chosen, onChange, disabled }: { title: string; desc?: string; all: string[]; chosen: string[]; onChange: (chosen: string[], disabled: string[]) => void; disabled?: string[] }) {
  const [q, setQ] = useState('')
  const avail = all.filter((o) => !chosen.includes(o) && o.toLowerCase().includes(q.toLowerCase()))
  const off = disabled ?? []
  return (
    <Field title={title} desc={desc}>
      <input type="search" placeholder="Search available…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="stack" style={{ maxHeight: 160, overflowY: 'auto', margin: '6px 0' }}>
        {all.length === 0 && <div className="muted small">Nothing configured yet — add entries in the plugin's configuration on the Plugins page.</div>}
        {avail.map((o) => <div className="row between" key={o}><span>{o}</span><button className="sm" onClick={() => onChange([...chosen, o], off)}>+ Add</button></div>)}
        {all.length > 0 && avail.length === 0 && <div className="muted small">No matches.</div>}
      </div>
      <strong className="small">Selected ({chosen.length}){chosen.length === 0 && ' — none; nothing is exposed'}</strong>
      <div className="stack">{chosen.map((o) => (
        <div className="row between" key={o}>
          <label className="check"><input type="checkbox" disabled={!disabled} checked={!off.includes(o)} onChange={(e) => onChange(chosen, e.target.checked ? off.filter((x) => x !== o) : [...off, o])} /> {o}{!all.includes(o) && <span className="muted small"> ⚠ no longer exists</span>}</label>
          <button className="sm danger" title="Remove" onClick={() => onChange(chosen.filter((x) => x !== o), off.filter((x) => x !== o))}>🗑</button>
        </div>
      ))}</div>
    </Field>
  )
}

function KeyValues({ keys, obj, onChange }: { keys: string[]; obj: Record<string, any>; onChange: (o: any) => void }) {
  const [nk, setNk] = useState('')
  return (
    <div className="field">
      {keys.map((k) => (
        <div className="kv" key={k}>
          <input type="text" value={k} readOnly />
          <input type="text" value={obj[k] ?? ''} onChange={(e) => onChange({ ...obj, [k]: e.target.value })} />
          <button className="sm danger" onClick={() => { const n = { ...obj }; delete n[k]; onChange(n) }}>✕</button>
        </div>
      ))}
      <div className="kv">
        <input type="text" placeholder="new key" value={nk} onChange={(e) => setNk(e.target.value)} />
        <span />
        <button className="sm" disabled={!nk || nk in obj} onClick={() => { onChange({ ...obj, [nk]: '' }); setNk('') }}>+ Add</button>
      </div>
    </div>
  )
}

function SecretInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false)
  return (
    <div className="secret">
      {show ? <textarea value={value} onChange={(e) => onChange(e.target.value)} style={{ minHeight: 40 }} />
        : <input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />}
      <button className="sm" type="button" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
      {value && <button className="sm" type="button" onClick={() => onChange('')}>Clear</button>}
    </div>
  )
}

function Field({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return <div className="field"><label>{title}</label>{children}{desc && <div className="desc">{desc}</div>}</div>
}

/** Collapsible list entry; entries without a name yet (just added) start expanded. */
function Entry({ title, sub, startOpen, actions, children }: { title: string; sub?: string; startOpen: boolean; actions: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <div className="card sub">
      <div className="row between">
        <button className="sm" onClick={() => setOpen(!open)} style={{ flex: 1, textAlign: 'left' }}>{open ? '▾' : '▸'} <strong>{title}</strong>{sub && <span className="muted small"> — {sub}</span>}</button>
        <span className="row">{actions}</span>
      </div>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  )
}
