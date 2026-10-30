import { getDb } from './db.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Per-server verbosity: what gets persisted. */
export type ServerLogLevel = 'off' | 'connections' | 'tools' | 'full';
export const SERVER_LOG_LEVELS: ServerLogLevel[] = ['off', 'connections', 'tools', 'full'];

export interface LogEntry {
  level: LogLevel;
  category: string; // system | auth | session | tool | plugin | <plugin-defined>
  message: string;
  serverId?: string;
  pluginInstanceId?: string;
  sessionId?: string;
  data?: unknown;
}

const listeners = new Set<(e: LogEntry & { ts: string }) => void>();
export function onLog(fn: (e: LogEntry & { ts: string }) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let insert: import("better-sqlite3").Statement<unknown[]> | undefined;

export function log(e: LogEntry) {
  const ts = new Date().toISOString();
  const line = `${ts} ${e.level.toUpperCase().padEnd(5)} [${e.category}]${e.serverId ? ` srv=${e.serverId}` : ''} ${e.message}`;
  (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(line);
  insert ??= getDb().prepare(
    'INSERT INTO logs(level,category,server_id,plugin_instance_id,session_id,message,data) VALUES(?,?,?,?,?,?,?)'
  );
  let data: string | null = null;
  if (e.data !== undefined) {
    try { data = JSON.stringify(e.data); } catch { data = String(e.data); }
    if (data && data.length > 64_000) data = data.slice(0, 64_000) + '…[truncated]';
  }
  insert.run(e.level, e.category, e.serverId ?? null, e.pluginInstanceId ?? null, e.sessionId ?? null, e.message, data);
  for (const l of listeners) l({ ...e, ts });
}

/** Logger bound to a server/plugin; filters by the server's configured verbosity. */
export class ScopedLogger {
  constructor(
    private scope: { serverId?: string; pluginInstanceId?: string; category?: string },
    private verbosity: () => ServerLogLevel = () => 'full'
  ) {}

  private emit(level: LogLevel, message: string, data?: unknown, extra?: Partial<LogEntry>) {
    log({ level, category: this.scope.category ?? 'plugin', message, data, ...this.scope, ...extra });
  }
  debug(m: string, d?: unknown) { if (this.verbosity() === 'full') this.emit('debug', m, d); }
  info(m: string, d?: unknown) { if (this.verbosity() !== 'off') this.emit('info', m, d); }
  warn(m: string, d?: unknown) { this.emit('warn', m, d); }
  error(m: string, d?: unknown) { this.emit('error', m, d); }
  /** Connection-level events (ssh connect, http request) — persisted at 'connections' and above. */
  connection(m: string, d?: unknown, sessionId?: string) {
    if (this.verbosity() !== 'off') this.emit('info', m, d, { category: 'connection', sessionId });
  }
  child(category: string) {
    return new ScopedLogger({ ...this.scope, category }, this.verbosity);
  }
}

export function pruneLogs(keepDays: number) {
  getDb().prepare(`DELETE FROM logs WHERE ts < datetime('now', ?)`).run(`-${keepDays} days`);
}
