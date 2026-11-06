/**
 * Human-in-the-loop gate. A gated tool call is recorded, the call blocks for `approvalWaitSec`
 * hoping an admin decides, and otherwise returns an error telling the agent to retry the *same call*
 * later. A retry with identical args is a "check back": it never creates a second request. After
 * `approvalMaxAttempts` unanswered check-backs the agent is told to pause and stop retrying.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb, type Row } from './db.js';
import { getGlobalConfig } from './global-config.js';
import type { ApprovalPolicy } from './store.js';
import type { ToolDefinition } from './plugin-api.js';
import { log } from './logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used';
export interface ApprovalRecord {
  id: string; server_id: string; instance_id: string; instance_name: string; tool: string; principal: string; session_id?: string;
  args: any; status: ApprovalStatus; attempts: number; decided_by?: string; created_at: number; decided_at?: number; expires_at: number;
}
const row = (r: Row): ApprovalRecord => ({ ...r, args: JSON.parse(r.args) } as ApprovalRecord);

// in-memory waiters: a decision wakes the blocked call immediately instead of at the deadline
const waiters = new Map<string, Set<() => void>>();
const wake = (id: string) => { for (const w of waiters.get(id) ?? []) w(); waiters.delete(id); };

/** Canonical JSON so {a:1,b:2} and {b:2,a:1} are the same request. */
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);

export const approvals = {
  needsApproval(policy: ApprovalPolicy | undefined, tool: ToolDefinition): boolean {
    switch (policy?.mode) {
      case 'all': return true;
      case 'writes': return !tool.annotations?.readOnlyHint;
      case 'list': return (policy.tools ?? []).includes(tool.name);
      default: return false;
    }
  },

  list(which: 'pending' | 'decided', limit = 200): ApprovalRecord[] {
    this.expire();
    const sql = which === 'pending'
      ? 'SELECT * FROM approvals WHERE status=? ORDER BY created_at LIMIT ?'
      : "SELECT * FROM approvals WHERE status<>'pending' ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?";
    const rows = which === 'pending' ? getDb().prepare(sql).all('pending', limit) : getDb().prepare(sql).all(limit);
    return (rows as Row[]).map(row);
  },

  decide(id: string, status: 'approved' | 'denied', by: string): ApprovalRecord {
    const r = getDb().prepare("UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'").run(status, by, Date.now(), id);
    if (!r.changes) throw new Error('approval not pending');
    wake(id);
    const rec = row(getDb().prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row);
    log({ level: 'info', category: 'approval', serverId: rec.server_id, pluginInstanceId: rec.instance_id, sessionId: rec.session_id, message: `${rec.tool} by ${rec.principal} ${status} by ${by}` });
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

  /**
   * Returns undefined when the call may proceed, else { status, message } to hand back to the agent as an error.
   * An approved request is consumed by exactly one execution.
   */
  async gate(req: { serverId: string; instanceId: string; instanceName: string; tool: string; principal: string; sessionId?: string; args: any; signal?: AbortSignal }): Promise<{ status: string; message: string } | undefined> {
    const g = getGlobalConfig();
    const db = getDb();
    this.expire();
    const key = createHash('sha256').update(`${req.instanceId}\0${req.tool}\0${req.principal}\0${canon(req.args)}`).digest('hex');
    let rec = db.prepare("SELECT * FROM approvals WHERE key=? AND status IN ('pending','approved','denied') AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(key, Date.now()) as Row | undefined;
    // a denial sticks until the request expires: identical retries are refused without creating a new request
    if (rec?.status === 'denied') return { status: 'denied', message: `Denied: a human reviewer rejected this ${req.tool} call. Do not retry it with the same arguments.` };
    if (rec) db.prepare('UPDATE approvals SET attempts=attempts+1 WHERE id=?').run(rec.id);
    else {
      const id = randomUUID(), now = Date.now();
      db.prepare('INSERT INTO approvals(id,server_id,instance_id,instance_name,tool,principal,session_id,args,key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, req.serverId, req.instanceId, req.instanceName, req.tool, req.principal, req.sessionId ?? null, JSON.stringify(req.args), key, now, now + g.approvalTtlSec * 1000);
      rec = db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row;
      log({ level: 'info', category: 'approval', serverId: req.serverId, pluginInstanceId: req.instanceId, sessionId: req.sessionId, message: `${req.tool} by ${req.principal} awaiting approval`, data: { args: req.args } });
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
    const now = db.prepare('SELECT status FROM approvals WHERE id=?').get(id) as Row;
    switch (now.status as ApprovalStatus) {
      case 'approved':
        // atomic: concurrent identical calls must not all ride one approval
        if (db.prepare("UPDATE approvals SET status='used' WHERE id=? AND status='approved'").run(id).changes) return undefined;
        return { status: 'pending', message: 'This approval was already used by a concurrent call. Call again to request approval anew.' };
      case 'denied':
        return { status: 'denied', message: `Denied: a human reviewer rejected this ${req.tool} call. Do not retry it with the same arguments.` };
      case 'expired':
        return { status: 'expired', message: `Approval request expired before a human reviewed it. Call again to request approval anew.` };
      default:
        if (attempts >= g.approvalMaxAttempts)
          return { status: 'paused', message: `Still awaiting human approval after ${attempts} attempts. PAUSE: stop retrying this call, tell the user it needs approval in MControlProgram (request ${id}), and only call again when the user says it has been approved.` };
        return { status: 'pending', message: `Awaiting human approval (request ${id}, attempt ${attempts} of ${g.approvalMaxAttempts}). Wait at least ${g.approvalWaitSec}s, then call this tool again with exactly the same arguments to check back; do not create a different request.` };
    }
  },
};
