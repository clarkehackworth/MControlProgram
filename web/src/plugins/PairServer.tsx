import { api, type PluginMeta, type Server } from '../api'
import { Modal, useAction } from '../components/ui'

/** Pick which MCP servers use an inventory item: ticking adds it to that server's `p.id` instance (created if missing), unticking removes it. */
export default function PairServer({ p, item, servers, field, dk, onClose, reload }: { p: PluginMeta; item: string; servers: Server[]; field: string; dk?: string; onClose: () => void; reload: () => Promise<void> }) {
  const { run, busy, error } = useAction()
  const toggle = (s: Server, on: boolean) => run(async () => {
    const inst = s.instances.find((i) => i.plugin_id === p.id)
    if (!inst) {
      if (on) await api(`/servers/${s.id}/instances`, { method: 'POST', body: { plugin_id: p.id, name: p.id, config: { [field]: [item] } } })
    } else {
      const cur = (inst.config[field] as string[]) ?? []
      const config = { ...inst.config, [field]: on ? [...new Set([...cur, item])] : cur.filter((x) => x !== item) }
      if (dk) config[dk] = ((inst.config[dk] as string[]) ?? []).filter((x) => x !== item)
      await api(`/instances/${inst.id}`, { method: 'PUT', body: { config } })
    }
    await reload()
  })
  return (
    <Modal title={`Pair server — ${item}`} onClose={onClose}>
      <p className="muted small">Choose the MCP servers that can use <code>{item}</code>. Pairing adds the {p.name} plugin to a server that doesn't have it yet.</p>
      {error && <p className="err small">{error}</p>}
      {servers.length === 0 && <p className="muted">No servers yet.</p>}
      <div className="chips" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        {servers.map((s) => {
          const inst = s.instances.find((i) => i.plugin_id === p.id)
          const paired = ((inst?.config[field] as string[]) ?? []).includes(item)
          return <label key={s.id}><input type="checkbox" checked={paired} disabled={busy} onChange={(e) => toggle(s, e.target.checked)} /> {s.name}</label>
        })}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button onClick={onClose}>Done</button></div>
    </Modal>
  )
}
