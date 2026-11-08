import { useEffect, useState, type ComponentType } from 'react'
import type { Approval, PluginMeta } from './api'

/**
 * A plugin's admin UI: the default export of `ui.js` in the plugin's directory, served at
 * /api/plugins/<id>/ui.js and imported at runtime. Build it as an ES module with `react`,
 * `react/jsx-runtime` and `@mcontrolprogram/ui` external, mapped to /sdk/react.js, /sdk/jsx-runtime.js
 * and /sdk/ui.js (see web/build-plugin-ui.mjs). A plugin may import a declared dependency's UI from
 * /api/plugins/<dep>/ui.js. Every slot is optional; without a ui.js the generic page is used.
 */
export interface PluginUi {
  /** Rendered on the plugin's page under its inventories (logs, rules, …). */
  Page?: ComponentType<{ plugin: PluginMeta; selected: Record<string, string | undefined> }>
  /** Per inventory (array key in the plugin's global config). */
  inventory?: Record<string, InventoryUi>
  /** Asks raised by this plugin (approval queue). */
  asks?: AskUi
}

export interface InventoryUi {
  /** Rows are clickable; the chosen one is highlighted and passed to `Page` as `selected[<inventory key>]` (first item by default). */
  selectable?: boolean
  /** Extra button(s) next to "+ Add", e.g. a guided wizard. Makes "+ Add" a secondary button. */
  AddButton?: ComponentType<{ reload: () => Promise<void> }>
  /** Shown in the edit dialog under the form, for an existing item. */
  EditExtra?: ComponentType<{ item: any }>
  /** Replaces the delete confirmation for items where `when(item)` holds. `remove()` deletes the item from the config. */
  Delete?: { when: (item: any) => boolean; Dialog: ComponentType<{ item: any; onClose: () => void; remove: () => Promise<void> }> }
}

export interface AskUi {
  /** The rule is one switch (e.g. a tool on/off): "Enable/Disable" buttons call `setRule`, no dialog. */
  direct?: (a: Approval) => boolean
  setRule?: (a: Approval, rule: 'allow' | 'deny') => Promise<void>
  /** "Add allow/block rule…" editor. `onDone` gets the action saved ('ask' leaves the call pending). */
  RuleDialog?: ComponentType<{ approval: Approval; action: 'allow' | 'block'; onClose: () => void; onDone: (action: string) => Promise<void> }>
}

const cache = new Map<string, Promise<PluginUi>>()
/** The plugin's UI module ({} if it has none). Same URL as plugins use to import each other, so one instance each. */
export function loadPluginUi(id: string): Promise<PluginUi> {
  let p = cache.get(id)
  if (!p) cache.set(id, (p = import(/* @vite-ignore */ `/api/plugins/${encodeURIComponent(id)}/ui.js`).then((m) => (m.default ?? {}) as PluginUi, (e) => { console.warn(`plugin ${id}: ui failed to load`, e); return {} })))
  return p
}

/** `has` = the plugin reports a ui.js; skip the request when it doesn't. */
export function usePluginUi(id: string | undefined, has = true): PluginUi | undefined {
  const [ui, setUi] = useState<PluginUi>()
  useEffect(() => {
    if (!id || !has) { setUi({}); return }
    let live = true
    void loadPluginUi(id).then((u) => { if (live) setUi(u) })
    return () => { live = false }
  }, [id, has])
  return ui
}
