/** Starts/stops RunningServer instances to match the DB. */
import { RunningServer } from './runtime.js';
import { servers as serverStore, instances as instanceStore } from '../core/store.js';
import { log } from '../core/logger.js';

const running = new Map<string, RunningServer>();
const failed = new Map<string, string>();

export const manager = {
  get: (id: string) => running.get(id),
  all: () => [...running.values()],
  lastError: (id: string) => failed.get(id),

  async startAll() {
    for (const rec of serverStore.list()) if (rec.enabled) await this.start(rec.id);
  },
  async stopAll() {
    for (const id of [...running.keys()]) await this.stop(id);
  },
  async start(id: string) {
    if (running.has(id)) return running.get(id)!;
    const rec = serverStore.get(id);
    if (!rec) throw new Error('server not found');
    const rs = new RunningServer(rec);
    try {
      await rs.start();
      running.set(id, rs);
      failed.delete(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.set(id, msg);
      log({ level: 'error', category: 'server', serverId: id, message: `failed to start "${rec.name}" on ${rec.host}:${rec.port}: ${msg}` });
      await rs.stop().catch(() => {});
      throw e;
    }
    return rs;
  },
  async stop(id: string) {
    const rs = running.get(id);
    if (!rs) return;
    running.delete(id);
    await rs.stop();
  },
  /** Apply a changed server record: restart if network/auth changed, else patch in place. */
  async apply(id: string) {
    const rec = serverStore.get(id);
    const rs = running.get(id);
    if (!rec) { await this.stop(id); return; }
    if (!rec.enabled) { await this.stop(id); return; }
    if (!rs) { await this.start(id); return; }
    const o = rs.record;
    const needsRestart = o.port !== rec.port || o.host !== rec.host || o.auth_mode !== rec.auth_mode || o.public_url !== rec.public_url || o.name !== rec.name;
    rs.record = rec;
    if (needsRestart) { await this.stop(id); await this.start(id); }
  },
  /** Plugin-wide config changed: restart every instance of that plugin on every running server. */
  async applyPlugin(pluginId: string) {
    for (const rs of running.values())
      for (const li of [...rs.live.values()]) if (li.record.plugin_id === pluginId) await rs.reloadInstance(li.record.id);
  },
  async applyInstance(instanceId: string, serverId: string) {
    const rs = running.get(serverId);
    if (!rs) return;
    const rec = instanceStore.get(instanceId);
    if (!rec || !rec.enabled) await rs.unloadInstance(instanceId);
    else await rs.reloadInstance(instanceId);
  },
};
