import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { log } from './logger.js';
import type { MControlProgramPlugin } from './plugin-api.js';
import { setting } from './db.js';
import { satisfies } from './semver.js';

const registry = new Map<string, MControlProgramPlugin & { source: string }>();

function isPlugin(x: any): x is MControlProgramPlugin {
  return x && typeof x.id === 'string' && typeof x.create === 'function' && x.configSchema;
}

async function loadFrom(specifier: string, source: string) {
  const mod = await import(specifier + (specifier.startsWith('file:') ? `?t=${Date.now()}` : ''));
  const p = mod.default ?? mod.plugin;
  if (!isPlugin(p)) throw new Error(`${source}: default export is not a MControlProgramPlugin`);
  if (!/^[a-z][a-z0-9_-]*$/.test(p.id)) throw new Error(`${source}: invalid plugin id "${p.id}"`);
  registry.set(p.id, Object.assign(p, { source }));
  log({ level: 'info', category: 'plugin', message: `loaded plugin ${p.id}@${p.version} (${source})` });
}

/** Scan: built-ins, data/plugins/<dir>, MCONTROLPROGRAM_PLUGIN_DIRS, and npm package names from settings. */
export async function loadPlugins() {
  registry.clear();
  const errors: string[] = [];
  const builtins = ['ssh', 'web', 'mcp', 'browserpaw'];
  for (const id of builtins) {
    try { await loadFrom(`../plugins/${id}/index.js`, `builtin:${id}`); }
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
      try { await loadFrom(pathToFileURL(entry).href, base); }
      catch (e) { errors.push(`${base}: ${(e as Error).message}`); }
    }
  }
  const npm = JSON.parse(setting.get('npmPlugins') ?? '[]') as string[];
  for (const name of npm) {
    try { await loadFrom(name, `npm:${name}`); }
    catch (e) { errors.push(`npm ${name}: ${(e as Error).message}`); }
  }
  errors.push(...checkDependencies());
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
  return errors;
}

/** `ctx.dep` for plugin `p`: the api of a declared, loaded dependency. */
export const depResolver = (p: MControlProgramPlugin) => <T = any>(id: string): T => {
  if (!p.dependencies?.[id]) throw new Error(`plugin ${p.id} did not declare a dependency on ${id}`);
  const d = registry.get(id);
  if (!d) throw new Error(`plugin ${p.id} needs ${id}, which is not loaded`);
  return d.api as T;
};

export const plugins = {
  get: (id: string) => registry.get(id),
  list: () => [...registry.values()],
};
