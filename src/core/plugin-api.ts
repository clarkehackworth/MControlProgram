/**
 * MControlProgram plugin API. A plugin is an ES module whose default export is a `MControlProgramPlugin`.
 * Plugins are instantiated once per plugin-instance on an MCP server. They own their connections
 * (ssh sessions, http clients, ...) and expose tools to agents through the MCP server.
 *
 * This is the only core module a plugin may import. Everything stateful (database, settings, secrets,
 * config, other plugins) reaches the plugin through `init(host)` and the contexts below.
 */
import type { ZodRawShape } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import type { ScopedLogger } from './logger.js';
import type { GlobalConfig } from './global-config.js';

export type { ScopedLogger, GlobalConfig };
export { safeRegex } from './safe-regex.js';

/** Instance override when > 0, else the MControlProgram-wide value (for "0 = use the default" config fields). */
export const effective = (override: number | undefined, globalValue: number) => (override && override > 0 ? override : globalValue);

/** JSON Schema subset used for plugin config. Mark secrets with `"x-secret": true`. */
export type ConfigSchema = Record<string, any>;

export interface ToolCallContext {
  /** MCP session id of the calling agent (undefined in stateless mode). */
  sessionId?: string;
  /** Authenticated principal (bearer token name / oauth client id). */
  principal?: string;
  signal: AbortSignal;
  log: ScopedLogger;
  /**
   * Ask a human to approve something this call wants to do (the plugin's own "ask" rules). Shows on the
   * Approvals page and the plugin's page. Resolves with who approved ("approved by …"); throws an
   * `ApprovalError` whose message tells the agent to check back, pause, or not retry. Undefined outside a
   * tool call (tests, admin actions): plugins must then refuse, not proceed.
   */
  ask?(req: AskSpec): Promise<string>;
}

export interface AskSpec {
  /** Which feature of the plugin asks (e.g. 'command', 'url'); the plugin page groups and renders by it. */
  feature: string;
  /** One line for the admin, e.g. `web01: rm -rf /tmp/x`. */
  summary: string;
  /** Why it asks, e.g. the matching ask rule's label or 'default: ask'. */
  reason?: string;
  /** What is being asked about. Identical subjects (per instance, tool, principal) are the same request; the UI uses it to prefill rules. */
  subject: unknown;
}

/** `ctx.ask` or fail closed: no approval system available means no. */
export async function ask(ctx: Pick<ToolCallContext, 'ask'>, spec: AskSpec): Promise<string> {
  if (!ctx.ask) throw new Error(`needs human approval (${spec.reason ?? spec.summary}), but this call has no approval channel`);
  return ctx.ask(spec);
}

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolDefinition<Args extends ZodRawShape = ZodRawShape> {
  /** Short name; MControlProgram prefixes it with the plugin instance name, e.g. `ssh_exec`. */
  name: string;
  title?: string;
  description: string;
  inputSchema?: Args;
  /** Raw JSON Schema instead of a zod shape (pass-through tools). Args are not validated by MControlProgram. */
  jsonSchema?: Record<string, any>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: any, ctx: ToolCallContext) => Promise<ToolResult> | ToolResult;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read: (ctx: ToolCallContext) => Promise<{ text?: string; blob?: string; mimeType?: string }>;
}

/** Context given to plugin-level actions (wizards, key generation, connection tests). */
export interface PluginActionContext {
  /** Decrypted plugin-wide config. */
  config: Record<string, any>;
  /** Persist new plugin-wide config (secrets are encrypted; all instances of the plugin reload). */
  setConfig(next: Record<string, any>): Promise<void>;
  log: ScopedLogger;
  /** See `PluginHost.dep`. */
  dep<T = any>(id: string): T;
}

/** Services MControlProgram gives a plugin once per load, via `init(host)`. */
export interface PluginHost {
  /** The plugin's id. */
  id: string;
  /** Shared SQLite database. Name every table you create `<plugin id>_…`. */
  db: BetterSqlite3.Database;
  /** Key/value settings private to this plugin (stored as `<plugin id>.<key>`). */
  kv: { get(key: string): string | undefined; set(key: string, value: string): void };
  /** Encrypt/decrypt with MControlProgram's data key, for secrets kept outside the config. */
  secrets: { encrypt(plain: string): string; decrypt(blob: string): string };
  /** Current decrypted plugin-wide config, defaults applied. Read at use time: it changes when the admin saves. */
  config(): Record<string, any>;
  /** Absolute URL that runs this plugin's `callback` global action with the query params (OAuth redirects). */
  callbackUrl(): string;
  /** Live view of MControlProgram-wide defaults. */
  global(): GlobalConfig;
  log: ScopedLogger;
  /**
   * The `api` of a plugin listed in `dependencies` (throws if it is missing) or `optionalDependencies`
   * (undefined if it is missing or the wrong version). Dependencies are initialised before this plugin.
   */
  dep<T = any>(id: string): T;
}

export interface PluginContext {
  instanceId: string;
  instanceName: string;
  serverId: string;
  /** Validated, decrypted instance config. */
  config: Record<string, any>;
  /** Decrypted plugin-wide config (shared by every instance of this plugin). */
  pluginConfig: Record<string, any>;
  /** Live view of MControlProgram-wide defaults (idle timeouts, …). Read it at use time, not once at create. */
  global: () => GlobalConfig;
  log: ScopedLogger;
  /** See `PluginHost.dep`. */
  dep<T = any>(id: string): T;
}

export interface PluginInstance {
  tools: ToolDefinition[];
  resources?: ResourceDefinition[];
  /** Usage notes appended to the server's MCP instructions. `{prefix}` is replaced by this instance's tool prefix. */
  instructions?: string;
  /** Called when the server starts or the instance is (re)configured. */
  start?(): Promise<void> | void;
  /** Called on server stop, instance removal, or before reconfiguration. Must release connections. */
  stop?(): Promise<void> | void;
  /** Called when an MCP session ends; release per-session state if any. */
  onSessionClosed?(sessionId: string): Promise<void> | void;
  /** Arbitrary status shown in the UI (connection counts, health). */
  status?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Optional admin actions exposed as buttons in the UI (e.g. "test connection"). */
  actions?: Record<string, { title: string; run: (params?: Record<string, unknown>) => Promise<unknown> }>;
}

export interface MControlProgramPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  /** JSON Schema for the per-instance config. Rendered as a form in the UI. */
  configSchema: ConfigSchema;
  defaultConfig?: Record<string, any>;
  /**
   * JSON Schema for plugin-wide config shared by all instances (e.g. the SSH host inventory).
   * Edited from the Plugins page. Instance schemas may reference it with
   * `"x-options-from": "<key>"` on a string field to offer the `name`s of that array as choices.
   */
  globalConfigSchema?: ConfigSchema;
  defaultGlobalConfig?: Record<string, any>;
  /**
   * Plugin-level admin actions (run from the Plugins page), e.g. "add host", "generate key".
   * `inventory` limits the row button to one inventory table (a key of the global config); default all.
   */
  globalActions?: Record<string, { title: string; /** no generic button: internal, or the plugin's own UI calls it */ hidden?: boolean; inventory?: string; /** only show the button on items whose fields match */ when?: Record<string, unknown>; run: (params: Record<string, any>, ctx: PluginActionContext) => Promise<unknown> }>;
  /**
   * Other plugins this one needs: plugin id → semver range (`^1.2.0`, `>=0.2.0`, `*`).
   * A plugin whose dependencies are missing or the wrong version is not loaded. Reach a dependency's
   * `api` through `ctx.dep(id)`.
   */
  dependencies?: Record<string, string>;
  /** Plugins this one uses when present (same format). Missing or wrong-version ones: `dep(id)` returns undefined. */
  optionalDependencies?: Record<string, string>;
  /** What this plugin offers to plugins that depend on it (see `dependencies`). */
  api?: unknown;
  /** Called once per load, after dependencies are checked and before anything else runs. Keep the host for later. */
  init?(host: PluginHost): void;
  /** An inventory item (global config array `key`) was renamed; references in configs are already rewritten. Update anything else keyed by the name. */
  onRenamed?(key: string, from: string, to: string): void;
  /** Default tool prefix (defaults to id). */
  toolPrefix?: string;
  create(ctx: PluginContext): PluginInstance | Promise<PluginInstance>;
}

export const text = (s: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: s }], isError });
export const errorResult = (e: unknown): ToolResult => text(e instanceof Error ? e.message : String(e), true);
