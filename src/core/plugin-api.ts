/**
 * MControlProgram plugin API. A plugin is an ES module whose default export is a `MControlProgramPlugin`.
 * Plugins are instantiated once per plugin-instance on an MCP server. They own their connections
 * (ssh sessions, http clients, ...) and expose tools to agents through the MCP server.
 */
import type { ZodRawShape } from 'zod';
import type { ScopedLogger } from './logger.js';
import type { GlobalConfig } from './global-config.js';

/** JSON Schema subset used for plugin config. Mark secrets with `"x-secret": true`. */
export type ConfigSchema = Record<string, any>;

export interface ToolCallContext {
  /** MCP session id of the calling agent (undefined in stateless mode). */
  sessionId?: string;
  /** Authenticated principal (bearer token name / oauth client id). */
  principal?: string;
  signal: AbortSignal;
  log: ScopedLogger;
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
  /** The `api` of a plugin listed in this plugin's `dependencies`. Throws for undeclared or missing ones. */
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
  /** The `api` of a plugin listed in this plugin's `dependencies`. Throws for undeclared or missing ones. */
  dep<T = any>(id: string): T;
}

export interface PluginInstance {
  tools: ToolDefinition[];
  resources?: ResourceDefinition[];
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
  globalActions?: Record<string, { title: string; inventory?: string; run: (params: Record<string, any>, ctx: PluginActionContext) => Promise<unknown> }>;
  /**
   * Other plugins this one needs: plugin id → semver range (`^1.2.0`, `>=0.2.0`, `*`).
   * A plugin whose dependencies are missing or the wrong version is not loaded. Reach a dependency's
   * `api` through `ctx.dep(id)`.
   */
  dependencies?: Record<string, string>;
  /** What this plugin offers to plugins that depend on it (see `dependencies`). */
  api?: unknown;
  /** Default tool prefix (defaults to id). */
  toolPrefix?: string;
  create(ctx: PluginContext): PluginInstance | Promise<PluginInstance>;
}

export const text = (s: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: s }], isError });
export const errorResult = (e: unknown): ToolResult => text(e instanceof Error ? e.message : String(e), true);
