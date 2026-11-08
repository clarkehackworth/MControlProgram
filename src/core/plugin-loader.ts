import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { log, ScopedLogger } from './logger.js';
import type { MControlProgramPlugin, PluginHost } from './plugin-api.js';
import { getDb, setting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { getGlobalConfig } from './global-config.js';
import { pluginConfig } from './store.js';
import { satisfies } from './semver.js';

const registry = new Map<string, MControlProgramPlugin & { source: string; dir?: string }>();

function isPlugin(x: any): x is MControlProgramPlugin {
  return x && typeof x.id === 'string' && typeof x.create === 'function' && x.configSchema;
}

/** `dir` = the plugin's directory, where an optional `ui.js` (its admin UI module) lives. */
async function loadFrom(specifier: string, source: string, dir?: string) {
  const mod = await import(specifier + (specifier.startsWith('file:') ? `?t=${Date.now()}` : ''));
  const p = mod.default ?? mod.plugin;
  if (!isPlugin(p)) throw new Error(`${source}: default export is not a MControlProgramPlugin`);
  if (!/^[a-z][a-z0-9_-]*$/.test(p.id)) throw new Error(`${source}: invalid plugin id "${p.id}"`);
  registry.set(p.id, Object.assign(p, { source, dir }));
  log({ level: 'info', category: 'plugin', message: `loaded plugin ${p.id}@${p.version} (${source})` });
}

/** Scan: built-ins, data/plugins/<dir>, MCONTROLPROGRAM_PLUGIN_DIRS, and npm package names from settings. */
export async function loadPlugins() {
  registry.clear();
  const errors: string[] = [];
  const builtinDir = new URL('../plugins/', import.meta.url);
  const builtins = fs.readdirSync(builtinDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const id of builtins) {
    try { await loadFrom(`../plugins/${id}/index.js`, `builtin:${id}`, fileURLToPath(new URL(id, builtinDir))); }
    catch (e) { errors.push(`builtin ${id}: ${(e as Error).message}`); }
  }
  const dirs = [path.join(config.dataDir, 'plugins'), ...config.pluginDirs];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const base = path.join(dir, ent.name);
      let entry: string | undefined;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
        entry = path.join(base, pkg.main ?? 'index.js');
      } catch {
        for (const f of ['index.js', 'index.mjs']) if (fs.existsSync(path.join(base, f))) entry = path.join(base, f);
      }
      if (!entry) continue;
      try { await loadFrom(pathToFileURL(entry).href, base, base); }
      catch (e) { errors.push(`${base}: ${(e as Error).message}`); }
    }
  }
  const npm = JSON.parse(setting.get('npmPlugins') ?? '[]') as string[];
  for (const name of npm) {
    try { await loadFrom(name, `npm:${name}`, npmDir(name)); }
    catch (e) { errors.push(`npm ${name}: ${(e as Error).message}`); }
  }
  errors.push(...checkDependencies());
  // Dependencies first, so a plugin's init may already use them. `seen` before recursing: cycles can't loop.
  const seen = new Set<string>();
  const init = (p: MControlProgramPlugin) => {
    if (seen.has(p.id)) return; seen.add(p.id);
    for (const id of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) { const d = registry.get(id); if (d) init(d); }
    if (!registry.has(p.id)) return;
    try { p.init?.(makeHost(p)); }
    catch (e) { registry.delete(p.id); errors.push(`${p.id}: init failed: ${(e as Error).message}`); }
  };
  for (const p of [...registry.values()]) init(p);
  for (const e of errors) log({ level: 'error', category: 'plugin', message: e });
  return { loaded: [...registry.keys()], errors };
}

/** Unload plugins whose dependencies are missing or out of range, repeating until stable (dependents of dropped plugins drop too). */
function checkDependencies() {
  const errors: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const p of registry.values()) {
      const bad = Object.entries(p.dependencies ?? {}).flatMap(([id, range]) => {
        const d = registry.get(id);
        if (!d) return [`${id} ${range} (not loaded)`];
        try { return satisfies(d.version, range) ? [] : [`${id} ${range} (found ${d.version})`]; }
        catch (e) { return [`${id} ${range} (${(e as Error).message})`]; }
      });
      if (bad.length) { registry.delete(p.id); errors.push(`${p.id}: unmet dependencies: ${bad.join(', ')}`); changed = true; }
    }
  }
  for (const p of registry.values()) for (const [id, range] of Object.entries(p.optionalDependencies ?? {})) {
    const d = registry.get(id);
    if (d && !inRange(d.version, range)) errors.push(`${p.id}: optional dependency ${id} ${range} found ${d.version}; running without it`);
  }
  return errors;
}
const inRange = (v: string, range: string) => { try { return satisfies(v, range); } catch { return false; } };

/** `ctx.dep` for plugin `p`: the api of a declared, loaded dependency (undefined for an absent optional one). */
export const depResolver = (p: MControlProgramPlugin) => <T = any>(id: string): T => {
  const optional = p.optionalDependencies?.[id];
  if (!p.dependencies?.[id] && !optional) throw new Error(`plugin ${p.id} did not declare a dependency on ${id}`);
  const d = registry.get(id);
  if (optional && !p.dependencies?.[id]) return (d && inRange(d.version, optional) ? d.api : undefined) as T;
  if (!d) throw new Error(`plugin ${p.id} needs ${id}, which is not loaded`);
  return d.api as T;
};

/** The services handed to `p.init`. */
export function makeHost(p: MControlProgramPlugin): PluginHost {
  const k = (key: string) => `${p.id}.${key}`;
  return {
    id: p.id,
    get db() { return getDb(); },
    kv: { get: (key) => setting.get(k(key)), set: (key, value) => setting.set(k(key), value) },
    secrets: { encrypt, decrypt },
    config: () => pluginConfig.decrypted(p.id),
    callbackUrl: () => `${config.publicUrl ?? `http://${config.adminHost}:${config.adminPort}`}/api/plugins/${p.id}/callback`,
    global: getGlobalConfig,
    log: new ScopedLogger({ category: `plugin:${p.id}` }),
    dep: depResolver(p),
  };
}

const npmDir = (name: string) => { try { return path.dirname(fileURLToPath(import.meta.resolve(name))); } catch { return undefined; } };

/** The plugin's admin UI module, if it ships one. */
function uiFile(id: string) {
  const dir = registry.get(id)?.dir;
  if (!dir) return undefined;
  // ponytail: built-ins run from src/ under tsx in dev, but their UI is built into dist/plugins/<id>/
  return [path.join(dir, 'ui.js'), path.join(dir.replace(/([/\\])src([/\\]plugins[/\\])/, '$1dist$2'), 'ui.js')].find((f) => fs.existsSync(f));
}

export const plugins = {
  get: (id: string) => registry.get(id),
  list: () => [...registry.values()],
  uiFile,
};
