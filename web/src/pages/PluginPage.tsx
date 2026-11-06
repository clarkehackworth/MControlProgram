import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, useApi, type PluginMeta, type Server } from '../api'
import { Alert, Json, Modal, useAction } from '../components/ui'
import SchemaForm, { defaultsFor, schemaError } from '../components/SchemaForm'
import SshAddHost from '../plugins/SshAddHost'
import SshPublicKey from '../plugins/SshPublicKey'
import PairServer from '../plugins/PairServer'
import SshDeleteHost from '../plugins/SshDeleteHost'
import WebTraffic from '../plugins/WebTraffic'
import SshCommands from '../plugins/SshCommands'

/** Array-of-object properties of a plugin's global config (SSH hosts, upstream servers, credentials…). */
export function inventoryKeys(p: PluginMeta): string[] {
  return Object.entries<any>(p.globalConfigSchema?.properties ?? {}).filter(([, s]) => s.type === 'array' && s.items?.type === 'object').map(([k]) => k)
}

// ponytail: wizard-driven / internal actions, and remove_host (rows use the generic Delete instead)
const HIDDEN_ACTIONS = ['add_host', 'copy_id', 'callback', 'remove_host', 'remove_key', 'public_key', 'requests', 'rules', 'rule', 'delete_rule', 'set_policy', 'clear_requests', 'sync_status', 'commands', 'clear_commands', 'preview', 'deny_candidates']

/** Full-width management page for one plugin's inventories. */
export default function PluginPage() {
  const { id } = useParams()
  const [plugins, reloadPlugins] = useApi<PluginMeta[]>('/plugins')
  const [servers, reloadServers] = useApi<Server[]>('/servers')
  const reload = async () => { await Promise.all([reloadPlugins(), reloadServers()]) }
  const p = plugins?.find((x) => x.id === id)
  if (!plugins) return null
  if (!p) return <Alert kind="err">Plugin "{id}" is not loaded.</Alert>
  return (
    <>
      <h1 style={{ marginBottom: 4 }}>{p.name}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{p.description}</p>
      {inventoryKeys(p).map((k) => <Inventory key={k} p={p} k={k} servers={servers ?? []} reload={reload} options={optionSources(p, plugins)} />)}
      {p.id === 'web' && <WebTraffic />}
      {p.id === 'browserpaw' && <WebTraffic plugin="browserpaw" />}
      {p.id === 'ssh' && <SshCommands hosts={((p.globalConfig?.hosts ?? []) as { name: string }[]).map((h) => h.name)} />}
    </>
  )
}

/** Values for `x-options-from`: this plugin's global config, plus `<pluginId>:<key>` for every other plugin's. */
function optionSources(p: PluginMeta, all: PluginMeta[]) {
  return { ...p.globalConfig, ...Object.fromEntries(all.flatMap((x) => Object.entries(x.globalConfig ?? {}).map(([k, v]) => [`${x.id}:${k}`, v]))) }
}

/** Instances of plugin `p` whose config selects from inventory `k`, with the field + disabled-list key. */
function fieldOf(p: PluginMeta, k: string) {
  const [field, fs] = Object.entries<any>(p.configSchema?.properties ?? {}).find(([, s]) => s.items?.['x-options-from'] === k) ?? []
  return { field: field as string | undefined, dk: fs?.['x-disabled-key'] as string | undefined }
}

function usersOf(p: PluginMeta, k: string, servers: Server[]) {
  const { field, dk } = fieldOf(p, k)
  if (!field) return []
  return servers.flatMap((s) => s.instances.filter((i) => i.plugin_id === p.id).map((inst) => ({ server: s, inst, field, dk })))
}

function ServerToggles({ item, users, reload }: { item: string; users: ReturnType<typeof usersOf>; reload: () => Promise<void> }) {
  const { run, busy } = useAction()
  const mine = users.filter((u) => ((u.inst.config[u.field] as string[]) ?? []).includes(item))
  if (mine.length === 0) return <span className="muted small">—</span>
  return <div className="chips" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>{mine.map(({ server, inst, dk }) => {
    const off = dk ? ((inst.config[dk] as string[]) ?? []) : []
    const on = !off.includes(item)
    return <label key={inst.id} className="chip small toggle" title={dk ? `${on ? 'Disable' : 'Enable'} ${item} for ${inst.name} on ${server.name}` : 'Edit the instance to change'}>
      <input type="checkbox" checked={on} disabled={busy || !dk} onChange={(e) => run(async () => {
        await api(`/instances/${inst.id}`, { method: 'PUT', body: { config: { ...inst.config, [dk!]: e.target.checked ? off.filter((x) => x !== item) : [...off, item] } } })
        await reload()
      })} /> {server.name}{inst.name !== inst.plugin_id ? `/${inst.name}` : ''}
    </label>
  })}</div>
}

function Inventory({ p, k, servers, reload, options }: { p: PluginMeta; k: string; servers: Server[]; reload: () => Promise<void>; options: Record<string, any> }) {
  const schema = p.globalConfigSchema.properties[k]
  const items: any[] = p.globalConfig?.[k] ?? []
  const users = usersOf(p, k, servers)
  const fk = fieldOf(p, k)
  // `x-referenced-by: { inventory, field }` on the inventory: items of another inventory that point at these by name
  const ref = schema['x-referenced-by'] as { inventory: string; field: string; title?: string } | undefined
  const refs = (name: string): string[] => ref ? ((p.globalConfig?.[ref.inventory] ?? []) as any[]).filter((x) => x[ref.field] === name).map((x) => x.name) : []
  const cols = Object.entries<any>(schema.items.properties).filter(([c, s]) => c !== 'name' && !s['x-secret'] && !s['x-hidden'] && !s['x-no-column'] && ['string', 'integer', 'number'].includes(s.type) && s.format !== 'multiline').slice(0, 4)
  const actions = p.globalActions.filter((a) => !HIDDEN_ACTIONS.includes(a.key) && (!a.inventory || a.inventory === k))
  const [editing, setEditing] = useState<{ index: number; value: any }>()
  const [wizard, setWizard] = useState(false)
  const [deleting, setDeleting] = useState<any>()
  const [pairing, setPairing] = useState<string>()
  const [out, setOut] = useState<any>()
  const { run, error, busy } = useAction()
  const save = (next: any[]) => api(`/plugins/${p.id}/config`, { method: 'PUT', body: { ...p.globalConfig, [k]: next } })
  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{schema.title ?? k} <span className="muted small">({items.length})</span></h2>
        <div className="row">
          {p.id === 'ssh' && k === 'hosts' && <button className="primary" onClick={() => setWizard(true)}>+ Add host (guided)</button>}
          <button className={p.id === 'ssh' ? '' : 'primary'} onClick={() => setEditing({ index: -1, value: defaultsFor(schema.items) })}>+ Add</button>
        </div>
      </div>
      {schema.description && <p className="muted small">{schema.description}</p>}
      {error && <Alert kind="err">{error}</Alert>}
      <table>
        <thead><tr><th>Name</th>{cols.map(([c, s]) => <th key={c}>{s.title ?? c}</th>)}{fk.field ? <th>Used by</th> : ref ? <th>{ref.title ?? ref.inventory}</th> : null}<th></th></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.name ?? i}>
              <td className="mono"><strong>{it.name}</strong></td>
              {cols.map(([c]) => <td key={c}>{String(it[c] ?? '')}</td>)}
              {fk.field ? <td><ServerToggles item={it.name} users={users} reload={reload} /></td> : ref ? <td>{refs(it.name).length ? <div className="chips">{refs(it.name).map((n) => <span key={n} className="chip small">{n}</span>)}</div> : <span className="muted small">—</span>}</td> : null}
              <td><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {actions.map((a) => <button key={a.key} className="sm" disabled={busy}
                  onClick={() => run(async () => { const r = await api<{ result: any }>(`/plugins/${p.id}/actions/${a.key}`, { method: 'POST', body: { name: it.name } }); setOut({ action: `${a.title} — ${it.name}`, ...r.result }) })}>{a.title}</button>)}
                {fk.field && <button className="sm" onClick={() => setPairing(it.name)}>Pair server</button>}
                <button className="sm" onClick={() => setEditing({ index: i, value: it })}>Edit</button>
                <button className="sm danger" disabled={busy} onClick={() => { if (p.id === 'ssh' && k === 'hosts' && it.auth === 'key') setDeleting(it); else if (window.confirm(`Delete "${it.name}"?${refs(it.name).length ? ` It is used by ${ref!.inventory}: ${refs(it.name).join(', ')}, which will stop working.` : ''}`)) void run(async () => { await save(items.filter((_, j) => j !== i)); await reload() }) }}>Delete</button>
              </div></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={cols.length + 2 + (fk.field || ref ? 1 : 0)} className="muted">None configured.</td></tr>}
        </tbody>
      </table>
      {out?.authorizeUrl && <Alert kind="ok">Open <a href={out.authorizeUrl} target="_blank" rel="noreferrer">the authorization page</a>, approve, then run "Test server".</Alert>}
      {out && <div style={{ marginTop: 12 }}><div className="row between"><strong className="small">{out.action}</strong><button className="sm" onClick={() => setOut(undefined)}>Clear</button></div><Json value={out} /></div>}
      {editing && <Modal title={editing.index < 0 ? `Add to ${schema.title ?? k}` : `Edit ${editing.value.name}`} onClose={() => setEditing(undefined)}>
        <p className="muted small">Shared by every <code>{p.id}</code> instance on every server. Saving restarts those instances. Secrets show as •••••••• — leave them to keep the stored value.</p>
        <SchemaForm schema={schema.items} value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} options={options} />
        {p.id === 'ssh' && k === 'hosts' && editing.index >= 0 && editing.value.auth === 'key' && <SshPublicKey name={editing.value.name} />}
        <div className="row between" style={{ marginTop: 12 }}>
          <button onClick={() => setEditing(undefined)}>Cancel</button>
          <button className="primary" title={schemaError(schema.items, editing.value)} disabled={busy || !editing.value.name || !!schemaError(schema.items, editing.value)} onClick={() => run(async () => {
            await save(editing.index < 0 ? [...items, editing.value] : items.map((x, j) => (j === editing.index ? editing.value : x)))
            setEditing(undefined); await reload()
          })}>Save</button>
        </div>
      </Modal>}
      {deleting && <SshDeleteHost name={deleting.name} onClose={() => setDeleting(undefined)} onDone={async (removeKey, password) => {
        if (removeKey) await api(`/plugins/ssh/actions/remove_key`, { method: 'POST', body: { name: deleting.name, password: password || undefined } })
        await save(items.filter((x) => x.name !== deleting.name)); setDeleting(undefined); await reload()
      }} />}
      {pairing && fk.field && <PairServer p={p} item={pairing} servers={servers} field={fk.field} dk={fk.dk} onClose={() => setPairing(undefined)} reload={reload} />}
      {wizard && <SshAddHost onClose={() => setWizard(false)} onDone={async () => { setWizard(false); await reload() }} />}
    </div>
  )
}
