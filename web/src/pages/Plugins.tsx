import { useEffect, useState } from 'react'
import { api, useApi, type PluginMeta } from '../api'
import { Alert, Badge, Json, Modal, useAction } from '../components/ui'
import { ConfigEditor } from './ServerDetail'
import { Link } from 'react-router-dom'
import { inventoryKeys } from './PluginPage'

export default function Plugins() {
  const [plugins, reload] = useApi<PluginMeta[]>('/plugins')
  const [npm, reloadNpm] = useApi<string[]>('/plugins/npm')
  const [list, setList] = useState('')
  const [result, setResult] = useState<any>()
  const [configuring, setConfiguring] = useState<PluginMeta>()
  const { run, error, busy } = useAction()
  useEffect(() => { if (npm) setList(npm.join('\n')) }, [npm])
  return (
    <>
      <div className="row between" style={{ marginBottom: 16 }}><h1 style={{ margin: 0 }}>Plugins</h1>
        <button disabled={busy} onClick={() => run(async () => { setResult(await api('/plugins/reload', { method: 'POST' })); await reload() })}>Reload plugins</button></div>
      {error && <Alert kind="err">{error}</Alert>}
      {result && <Alert kind={result.errors?.length ? 'err' : 'ok'}>Loaded: {result.loaded.join(', ')}{result.errors?.length ? <> — errors: {result.errors.join('; ')}</> : null}</Alert>}
      {plugins?.map((p) => (
        <div className="card" key={p.id}>
          <div className="row between">
            <div className="row"><strong>{p.name}</strong><Badge kind="info">{p.id}@{p.version}</Badge>{Object.entries(p.dependencies ?? {}).map(([d, r]) => <span key={d} className="muted small">needs {d} {r}</span>)}<span className="muted small">{p.source}</span></div>
            <div className="row">
              {inventoryKeys(p).length > 0 && <Link to={`/p/${p.id}`}><button>Manage {inventoryKeys(p).map((k) => (p.globalConfigSchema.properties[k].title ?? k).toLowerCase()).join(', ')} →</button></Link>}
              {settingsSchema(p) && <button className="primary" onClick={() => setConfiguring(p)}>Configure</button>}
            </div>
          </div>
          <p className="muted" style={{ margin: '6px 0' }}>{p.description}</p>
          {p.globalConfig && <PluginSummary p={p} />}
          <details><summary className="muted small">Instance config schema</summary><Json value={p.configSchema} /></details>
        </div>
      ))}
      <div className="card">
        <h2>Plugin sources</h2>
        <p className="muted small">MControlProgram loads built-in plugins, every directory under <code>data/plugins/</code> (and <code>MCONTROLPROGRAM_PLUGIN_DIRS</code>), and the npm package names below. Each plugin's default export must be a <code>MControlProgramPlugin</code>. Reload after changes.</p>
        <textarea value={list} onChange={(e) => setList(e.target.value)} placeholder="one npm package name per line" style={{ minHeight: 60 }} />
        <div style={{ marginTop: 8 }}><button disabled={busy} onClick={() => run(async () => { await api('/plugins/npm', { method: 'PUT', body: list.split('\n').map((s) => s.trim()).filter(Boolean) }); await reloadNpm() })}>Save npm list</button></div>
      </div>
      {configuring && <PluginConfig p={configuring} onClose={() => setConfiguring(undefined)} onChanged={reload} />}
    </>
  )
}

/** One-line summary of what's in the plugin-wide config (arrays of named things). */
function PluginSummary({ p }: { p: PluginMeta }) {
  const parts = Object.entries(p.globalConfig ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${(v as any[]).length} ${k}`)
  return parts.length ? <div className="muted small">Configured: {parts.join(', ')}</div> : null
}

/** Global schema without the inventories, which are managed on the plugin's own page. */
function settingsSchema(p: PluginMeta) {
  const inv = inventoryKeys(p)
  const properties = Object.fromEntries(Object.entries<any>(p.globalConfigSchema?.properties ?? {}).filter(([k, s]) => !inv.includes(k) && !s['x-hidden']))
  return Object.keys(properties).length ? { ...p.globalConfigSchema, properties } : undefined
}

function PluginConfig({ p, onClose, onChanged }: { p: PluginMeta; onClose: () => void; onChanged: () => Promise<void> }) {
  const [cfg, setCfg] = useState<any>(p.globalConfig ?? {})
  const { run, error, busy } = useAction()
  return (
    <Modal title={`${p.name} — plugin configuration`} onClose={onClose}>
      <p className="muted small">Shared by every <code>{p.id}</code> instance on every server. Saving restarts those instances.</p>
      {error && <Alert kind="err">{error}</Alert>}
      <ConfigEditor schema={settingsSchema(p)} value={cfg} onChange={setCfg} />
      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={busy} onClick={() => run(async () => { await api(`/plugins/${p.id}/config`, { method: 'PUT', body: cfg }); await onChanged(); onClose() })}>Save</button>
      </div>
    </Modal>
  )
}
