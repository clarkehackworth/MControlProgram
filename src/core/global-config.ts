/**
 * MControlProgram-wide defaults that plugins draw on. Stored in the settings table, editable in the UI.
 * Plugins read them through `ctx.global`; a plugin-level value of 0/empty means "use the global".
 */
import { setting } from './db.js';

export interface GlobalConfig {
  /** Agent state (shells, cookie jars, …) with no activity for this long is discarded. */
  stateIdleSec: number;
  /** Idle connections (ssh sockets, pools) are closed after this long with no activity. */
  connectionIdleSec: number;
  /** Days of logs to keep. */
  logRetentionDays: number;
  /** How long a gated tool call blocks waiting for a human before returning "pending, check back". */
  approvalWaitSec: number;
  /** After this many unanswered check-backs the agent is told to pause and stop retrying. */
  approvalMaxAttempts: number;
  /** Pending approval requests older than this expire. */
  approvalTtlSec: number;
  /**
   * Where asks are answered besides the Approvals page: 'ui' = only there; 'client' = also prompt the agent's own MCP client
   * (elicitation, e.g. Hermes approval prompts); 'api' = also API keys with the `approvals` permission (e.g. Control Tower).
   */
  approvalChannel: 'ui' | 'client' | 'api';
  /** With the client channel: how long a call waits on the client's prompt. Keep under the client's tool timeout (Hermes: 300s). */
  approvalClientWaitSec: number;
}

export const GLOBAL_DEFAULTS: GlobalConfig = {
  stateIdleSec: 2 * 86400,       // 2 days
  connectionIdleSec: 3600,       // 1 hour; state outlives the socket and reconnects on demand
  logRetentionDays: 30,
  approvalWaitSec: 30,
  approvalMaxAttempts: 3,
  approvalTtlSec: 86400,
  approvalChannel: 'ui',
  approvalClientWaitSec: 240,
};
export const APPROVAL_CHANNELS = ['ui', 'client', 'api'] as const;

export function getGlobalConfig(): GlobalConfig {
  const out = { ...GLOBAL_DEFAULTS };
  for (const k of Object.keys(out) as (keyof GlobalConfig)[]) {
    const v = setting.get(`global.${k}`);
    if (v === undefined) continue;
    if (typeof out[k] === 'string') (out as any)[k] = v;
    else if (!isNaN(Number(v))) (out as any)[k] = Number(v);
  }
  return out;
}

export function setGlobalConfig(patch: Partial<GlobalConfig>) {
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) setting.set(`global.${k}`, String(v));
}

