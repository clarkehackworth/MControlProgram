/**
 * `@mcontrolprogram/ui`: everything a plugin's admin UI may import from the app (served at /sdk/ui.js).
 * Same module instances as the app, so hooks, styles and the API client behave identically.
 */
export { api, useApi, fmtTime, copy } from '../api'
export type { Approval, Instance, PluginMeta, Server } from '../api'
export { Alert, Badge, CopyButton, Field, Json, LoadingRow, Modal, useAction } from '../components/ui'
export { PendingAsks } from '../components/Asks'
export { RuleGroup } from '../components/RuleGroup'
export type { GroupRule, RuleAction, RuleOps } from '../components/RuleGroup'
export { default as SchemaForm, defaultsFor, schemaError } from '../components/SchemaForm'
export type { AskUi, InventoryUi, PluginUi } from '../plugin-ui'
