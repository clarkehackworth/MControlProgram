/**
 * Human-in-the-loop gate, shared by the core tool gate and every plugin (via `ToolCallContext.ask`).
 * An "ask" is recorded, the call blocks for `approvalWaitSec` hoping an admin decides, and otherwise returns
 * an error telling the agent to retry the *same call* later. A retry with the same subject is a "check back":
 * it never creates a second request. After `approvalMaxAttempts` unanswered check-backs the agent is told to pause.
 *
 * Decisions are allow-once / deny-once. "Add allow rule" / "Add block rule" are the UI writing the plugin's
 * rule (plugin action or instance tool rules) and then deciding the ask, so the core knows nothing of rule shapes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb, type Row } from './db.js';
import { getGlobalConfig } from './global-config.js';
import type { ApprovalPolicy, ToolRule } from './store.js';
import type { ToolDefinition } from './plugin-api.js';
import { log } from './logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used';
export interface ApprovalRecord {
  id: string; server_id: string; instance_id: string; instance_name: string; tool: string; principal: string; session_id?: string;
  /** Plugin that asked, and which of its features ('tool' = the core per-tool gate). */
  plugin_id: string; feature: string;
  /** One line for the admin, why it asked (the matching ask rule or "default: ask"), and what the ask is about (feature-specific). */
  summary: string; reason: string; subject: any;
  args: any; status: ApprovalStatus; attempts: number; decided_by?: string; created_at: number; decided_at?: number; expires_at: number;
}
const row = (r: Row): ApprovalRecord => ({ ...r, args: JSON.parse(r.args), subject: r.subject ? JSON.parse(r.subject) : null } as ApprovalRecord);

export interface AskRequest {
  serverId: string; instanceId: string; instanceName: string; pluginId: string; tool: string; principal: string; sessionId?: string; args: any; signal?: AbortSignal;
  feature: string; summary?: string; reason?: string;
  /** Identity of the ask: identical subjects are the same request. Defaults to args. */
  subject?: unknown;
}
export type GateResult = { ok: true; by: string } | { ok: false; status: string; message: string };

/** Thrown by `ToolCallContext.ask` when the call may not proceed (yet). The message is for the agent. */
export class ApprovalError extends Error { constructor(public status: string, message: string) { super(message); } }

// in-memory waiters: a decision wakes the blocked call immediately instead of at the deadline
const waiters = new Map<string, Set<() => void>>();
const wake = (id: string) => { for (const w of waiters.get(id) ?? []) w(); waiters.delete(id); };

/** Canonical JSON so {a:1,b:2} and {b:2,a:1} are the same request. */
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);

export const approvals = {
  /** Instance tool gate: an explicit rule for the tool wins, else the mode. */
  toolRule(policy: ApprovalPolicy | undefined, tool: ToolDefinition): ToolRule {
    const r = policy?.rules?.[tool.name];
    if (r) return r;
    if (policy?.mode === 'all') return 'ask';
    if (policy?.mode === 'writes' && !tool.annotations?.readOnlyHint) return 'ask';
    return 'allow';
  },

  list(which: 'pending' | 'decided', opts: { limit?: number; plugin?: string } = {}): ApprovalRecord[] {
    this.expire();
    const where = which === 'pending' ? ["status='pending'"] : ["status<>'pending'"];
    const args: unknown[] = [];
    if (opts.plugin) { where.push('plugin_id=?'); args.push(opts.plugin); }
    const order = which === 'pending' ? 'created_at' : 'COALESCE(decided_at, created_at) DESC';
    return (getDb().prepare(`SELECT * FROM approvals WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, opts.limit ?? 200) as Row[]).map(row);
  },

  decide(id: string, status: 'approved' | 'denied', by: string): ApprovalRecord {
    const r = getDb().prepare("UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'").run(status, by, Date.now(), id);
    if (!r.changes) throw new Error('approval not pending');
    wake(id);
    const rec = row(getDb().prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row);
    log({ level: 'info', category: 'approval', serverId: rec.server_id, pluginInstanceId: rec.instance_id, sessionId: rec.session_id, message: `${rec.summary || rec.tool} by ${rec.principal} ${status} by ${by}` });
    return rec;
  },

  /** Undo a deny-once: the request is waiting again, so the agent's next identical call checks back instead of being refused. */
  reopen(id: string, by: string): ApprovalRecord {
    // attempts reset: the agent may already have been told to pause
    const r = getDb().prepare("UPDATE approvals SET status='pending', decided_by=NULL, decided_at=NULL, attempts=0 WHERE id=? AND status='denied' AND expires_at>?").run(id, Date.now());
    if (!r.changes) throw new Error('only an unexpired denial can be undone');
    const rec = row(getDb().prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row);
    log({ level: 'info', category: 'approval', serverId: rec.server_id, pluginInstanceId: rec.instance_id, sessionId: rec.session_id, message: `${rec.summary || rec.tool} by ${rec.principal}: denial undone by ${by}` });
    return rec;
  },

  /** Instance or server removed: nothing can execute these any more. */
  cancelFor(where: { instanceId?: string; serverId?: string }) {
    const col = where.instanceId ? 'instance_id' : 'server_id';
    const ids = (getDb().prepare(`SELECT id FROM approvals WHERE status='pending' AND ${col}=?`).all(where.instanceId ?? where.serverId) as Row[]).map((r) => r.id);
    if (!ids.length) return;
    getDb().prepare(`UPDATE approvals SET status='expired', decided_by='removed', decided_at=? WHERE id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids);
    ids.forEach(wake);
  },

  expire() {
    const ids = (getDb().prepare("SELECT id FROM approvals WHERE status='pending' AND expires_at<?").all(Date.now()) as Row[]).map((r) => r.id);
    if (ids.length) { getDb().prepare(`UPDATE approvals SET status='expired' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids); ids.forEach(wake); }
    // ponytail: keep decided rows for 30 days; no separate knob
    getDb().prepare("DELETE FROM approvals WHERE status<>'pending' AND COALESCE(decided_at, created_at)<?").run(Date.now() - 30 * 86400e3);
  },

  /** `ok` = the call may proceed (an approval is consumed by exactly one execution); else a message for the agent. */
  async gate(req: AskRequest): Promise<GateResult> {
    const g = getGlobalConfig();
    const db = getDb();
    this.expire();
    const subject = req.subject ?? req.args;
    const what = req.summary || req.tool;
    const key = createHash('sha256').update(`${req.instanceId}\0${req.feature}\0${req.tool}\0${req.principal}\0${canon(subject)}`).digest('hex');
    const denied = { ok: false, status: 'denied', message: `Denied: a human reviewer rejected this request (${what}). Do not retry it with the same arguments.` } as const;
    let rec = db.prepare("SELECT * FROM approvals WHERE key=? AND status IN ('pending','approved','denied') AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(key, Date.now()) as Row | undefined;
    // a denial sticks until the request expires: identical retries are refused without creating a new request
    if (rec?.status === 'denied') return denied;
    if (rec) db.prepare('UPDATE approvals SET attempts=attempts+1 WHERE id=?').run(rec.id);
    else {
      const id = randomUUID(), now = Date.now();
      db.prepare('INSERT INTO approvals(id,server_id,instance_id,instance_name,tool,principal,session_id,args,key,created_at,expires_at,plugin_id,feature,summary,reason,subject) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, req.serverId, req.instanceId, req.instanceName, req.tool, req.principal, req.sessionId ?? null, JSON.stringify(req.args ?? {}), key, now, now + g.approvalTtlSec * 1000,
          req.pluginId, req.feature, req.summary ?? '', req.reason ?? '', JSON.stringify(subject ?? null));
      rec = db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row;
      log({ level: 'info', category: 'approval', serverId: req.serverId, pluginInstanceId: req.instanceId, sessionId: req.sessionId, message: `${what} by ${req.principal} awaiting approval${req.reason ? ` (${req.reason})` : ''}`, data: { args: req.args } });
    }
    const id = rec!.id as string;
    const attempts = (db.prepare('SELECT attempts FROM approvals WHERE id=?').get(id) as Row).attempts as number; // calls including this one

    if (rec!.status === 'pending') {
      // block briefly in case the admin is watching
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, g.approvalWaitSec * 1000);
        function done() { clearTimeout(t); waiters.get(id)?.delete(done); req.signal?.removeEventListener('abort', done); resolve(); }
        (waiters.get(id) ?? waiters.set(id, new Set()).get(id)!).add(done);
        req.signal?.addEventListener('abort', done);
      });
    }
    const now = db.prepare('SELECT status, decided_by FROM approvals WHERE id=?').get(id) as Row;
    switch (now.status as ApprovalStatus) {
      case 'approved':
        // atomic: concurrent identical calls must not all ride one approval
        if (db.prepare("UPDATE approvals SET status='used' WHERE id=? AND status='approved'").run(id).changes) return { ok: true, by: `approved by ${now.decided_by}` };
        return { ok: false, status: 'pending', message: 'This approval was already used by a concurrent call. Call again to request approval anew.' };
      case 'denied': return denied;
      case 'expired':
        return { ok: false, status: 'expired', message: `Approval request expired before a human reviewed it. Call again to request approval anew.` };
      default:
        if (attempts >= g.approvalMaxAttempts)
          return { ok: false, status: 'paused', message: `Still awaiting human approval after ${attempts} attempts (${what}). PAUSE: stop retrying this call, tell the user it needs approval in MControlProgram (request ${id}), and only call again when the user says it has been approved.` };
        return { ok: false, status: 'pending', message: `Awaiting human approval for ${what} (request ${id}, attempt ${attempts} of ${g.approvalMaxAttempts}). Wait at least ${g.approvalWaitSec}s, then call this tool again with exactly the same arguments to check back; do not create a different request.` };
    }
  },
};
