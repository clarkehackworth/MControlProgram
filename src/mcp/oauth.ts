/**
 * OAuth 2.1 authorization server for one MControlProgram MCP server (authorization code + PKCE,
 * dynamic client registration, refresh tokens, revocation). Consent is given by a MControlProgram admin.
 */
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomUUID } from 'node:crypto';
import { getDb, type Row } from '../core/db.js';
import { throttle } from '../core/http-guard.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../core/crypto.js';
import { admins } from '../core/store.js';
import { log } from '../core/logger.js';

const DUMMY = hashPassword('dummy-for-constant-time');
const ACCESS_TTL = 3600;            // 1h
const REFRESH_TTL = 30 * 86400;     // 30d
const CODE_TTL = 600;               // 10m

export const oauthClients = {
  list: (serverId: string) => getDb().prepare('SELECT client_id,info,approved,created_at FROM oauth_clients WHERE server_id=? ORDER BY created_at').all(serverId)
    .map((r: any) => ({ client_id: r.client_id, approved: !!r.approved, created_at: r.created_at, ...JSON.parse(r.info) })),
  setApproved: (clientId: string, approved: boolean) => getDb().prepare('UPDATE oauth_clients SET approved=? WHERE client_id=?').run(approved ? 1 : 0, clientId),
  delete(clientId: string) {
    getDb().prepare('DELETE FROM oauth_tokens WHERE client_id=?').run(clientId);
    getDb().prepare('DELETE FROM oauth_clients WHERE client_id=?').run(clientId);
  },
  tokens: (serverId: string) => getDb().prepare('SELECT kind,client_id,scopes,expires_at,created_at FROM oauth_tokens WHERE server_id=? ORDER BY created_at DESC').all(serverId),
};

export class MControlProgramOAuthProvider implements OAuthServerProvider {
  constructor(private serverId: string, private serverName: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const serverId = this.serverId;
    return {
      getClient(clientId) {
        const r = getDb().prepare('SELECT * FROM oauth_clients WHERE client_id=? AND server_id=?').get(clientId, serverId) as Row | undefined;
        if (!r) return undefined;
        return { ...JSON.parse(r.info), client_id: r.client_id, client_secret: r.client_secret ?? undefined };
      },
      registerClient(client) {
        const client_id = randomUUID();
        const secret = client.token_endpoint_auth_method === 'none' ? null : randomToken(32);
        const full: OAuthClientInformationFull = { ...client, client_id, client_id_issued_at: Math.floor(Date.now() / 1000), client_secret: secret ?? undefined };
        getDb().prepare('INSERT INTO oauth_clients(client_id,server_id,client_secret,info,approved) VALUES(?,?,?,?,0)')
          .run(client_id, serverId, secret, JSON.stringify(client));
        log({ level: 'info', category: 'auth', serverId, message: `oauth client registered: ${client.client_name ?? client_id}`, data: { client_id, redirect_uris: client.redirect_uris } });
        return full;
      },
    };
  }

  /** Render consent page. Approval requires a MControlProgram admin login (cookie or inline form). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req as Request;
    const cookieSession = req.cookies?.mcontrolprogram_session;
    const admin = cookieSession ? admins.sessionUser(cookieSession) : undefined;
    const stateQ = new URLSearchParams({
      client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge,
      ...(params.state ? { state: params.state } : {}), ...(params.scopes?.length ? { scope: params.scopes.join(' ') } : {}),
      ...(params.resource ? { resource: params.resource.toString() } : {}),
    });
    res.type('html').send(consentPage({
      serverName: this.serverName, clientName: client.client_name ?? client.client_id, redirectUri: params.redirectUri,
      scopes: params.scopes ?? [], admin: admin?.username, query: stateQ.toString(),
    }));
  }

  /** POST /consent handler (installed by the server runtime). */
  async consent(req: Request, res: Response) {
    const b = req.body ?? {};
    let admin = req.cookies?.mcontrolprogram_session ? admins.sessionUser(req.cookies.mcontrolprogram_session) : undefined;
    if (!admin && b.username && b.password) {
      if (throttle.blocked(req)) { res.status(429).send('too many failed logins; try again later'); return; }
      const a = admins.get(String(b.username));
      if (verifyPassword(String(b.password), a?.password_hash ?? DUMMY) && a) { admin = { id: a.id, username: a.username }; throttle.ok(req); } else throttle.fail(req);
    }
    const redirect = new URL(String(b.redirect_uri ?? ''), 'http://invalid');
    if (!admin) { res.status(401).type('html').send('<p>Authentication failed. <a href="javascript:history.back()">Back</a></p>'); return; }
    const client = await this.clientsStore.getClient(String(b.client_id));
    if (!client || !client.redirect_uris.includes(String(b.redirect_uri))) { res.status(400).send('invalid client / redirect_uri'); return; }
    if (b.decision !== 'approve') {
      redirect.searchParams.set('error', 'access_denied');
      if (b.state) redirect.searchParams.set('state', String(b.state));
      res.redirect(redirect.toString()); return;
    }
    const code = randomToken(32);
    getDb().prepare('INSERT INTO oauth_codes(code,client_id,server_id,code_challenge,redirect_uri,scopes,resource,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(code, client.client_id, this.serverId, String(b.code_challenge), String(b.redirect_uri), String(b.scope ?? ''), b.resource ? String(b.resource) : null,
        Math.floor(Date.now() / 1000) + CODE_TTL);
    oauthClients.setApproved(client.client_id, true);
    log({ level: 'info', category: 'auth', serverId: this.serverId, message: `oauth consent granted by ${admin.username} to ${client.client_name ?? client.client_id}` });
    redirect.searchParams.set('code', code);
    if (b.state) redirect.searchParams.set('state', String(b.state));
    res.redirect(redirect.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const r = getDb().prepare('SELECT * FROM oauth_codes WHERE code=? AND client_id=? AND server_id=?').get(code, client.client_id, this.serverId) as Row | undefined;
    if (!r || r.expires_at < Date.now() / 1000) throw new Error('invalid or expired authorization code');
    return r.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const r = getDb().prepare('SELECT * FROM oauth_codes WHERE code=? AND client_id=? AND server_id=?').get(code, client.client_id, this.serverId) as Row | undefined;
    getDb().prepare('DELETE FROM oauth_codes WHERE code=?').run(code);
    if (!r || r.expires_at < Date.now() / 1000) throw new Error('invalid or expired authorization code');
    if (redirectUri && redirectUri !== r.redirect_uri) throw new Error('redirect_uri mismatch');
    return this.issue(client.client_id, r.scopes, r.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const r = getDb().prepare(`SELECT t.* FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id WHERE t.token_hash=? AND t.kind='refresh' AND t.client_id=? AND t.server_id=? AND c.approved=1`)
      .get(sha256(refreshToken), client.client_id, this.serverId) as Row | undefined;
    if (!r || (r.expires_at && r.expires_at < Date.now() / 1000)) throw new Error('invalid refresh token');
    getDb().prepare('DELETE FROM oauth_tokens WHERE token_hash=?').run(r.token_hash);
    const had = String(r.scopes ?? '').split(' ').filter(Boolean); // refresh may narrow scopes, never widen them
    if (scopes?.some((x) => !had.includes(x))) throw new Error('requested scope exceeds the original grant');
    return this.issue(client.client_id, scopes?.join(' ') ?? r.scopes, r.resource);
  }

  private issue(clientId: string, scopes: string, resource: string | null): OAuthTokens {
    const access = randomToken(32), refresh = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    const ins = getDb().prepare('INSERT INTO oauth_tokens(token_hash,kind,client_id,server_id,scopes,resource,expires_at) VALUES(?,?,?,?,?,?,?)');
    ins.run(sha256(access), 'access', clientId, this.serverId, scopes, resource, now + ACCESS_TTL);
    ins.run(sha256(refresh), 'refresh', clientId, this.serverId, scopes, resource, now + REFRESH_TTL);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = getDb().prepare(`SELECT t.*, c.info FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id
      WHERE t.token_hash=? AND t.kind='access' AND t.server_id=? AND c.approved=1`).get(sha256(token), this.serverId) as Row | undefined;
    if (!r) throw new Error('invalid token');
    if (r.expires_at && r.expires_at < Date.now() / 1000) throw new Error('token expired');
    const info = JSON.parse(r.info);
    return { token, clientId: r.client_id, scopes: r.scopes ? r.scopes.split(' ') : [], expiresAt: r.expires_at,
      resource: r.resource ? new URL(r.resource) : undefined, extra: { principal: `oauth:${info.client_name ? `${info.client_name}@${r.client_id.slice(0, 8)}` : r.client_id}` } };
  }

  async revokeToken(client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    getDb().prepare('DELETE FROM oauth_tokens WHERE token_hash=? AND client_id=?').run(sha256(req.token), client.client_id);
  }
}

export function pruneOAuth() {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare('DELETE FROM oauth_codes WHERE expires_at<?').run(now);
  getDb().prepare('DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at<?').run(now);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function consentPage(o: { serverName: string; clientName: string; redirectUri: string; scopes: string[]; admin?: string; query: string }) {
  const hidden = [...new URLSearchParams(o.query)].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>MControlProgram – Authorize</title>
<style>body{font:15px system-ui;background:#0f1419;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px;width:380px}h1{font-size:18px;margin:0 0 12px}
code{background:#0d1117;padding:2px 5px;border-radius:4px;word-break:break-all}label{display:block;margin:10px 0 4px;color:#8b949e}
input[type=text],input[type=password]{width:100%;padding:8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:inherit;box-sizing:border-box}
.row{display:flex;gap:8px;margin-top:18px}button{flex:1;padding:9px;border-radius:6px;border:0;cursor:pointer;font-weight:600}
.ok{background:#238636;color:#fff}.no{background:#30363d;color:#e6edf3}p{color:#8b949e}</style></head><body>
<form class="card" method="post" action="/consent">${hidden}
<h1>Authorize access to <em>${esc(o.serverName)}</em></h1>
<p><b>${esc(o.clientName)}</b> wants to connect to this MControlProgram MCP server.</p>
<p>Redirect: <code>${esc(o.redirectUri)}</code>${o.scopes.length ? `<br>Scopes: <code>${esc(o.scopes.join(' '))}</code>` : ''}</p>
${o.admin ? `<p>Approving as <b>${esc(o.admin)}</b>.</p>` : `<label>MControlProgram admin username</label><input type="text" name="username" autocomplete="username" required>
<label>Password</label><input type="password" name="password" autocomplete="current-password" required>`}
<div class="row"><button class="no" name="decision" value="deny">Deny</button><button class="ok" name="decision" value="approve">Approve</button></div>
</form></body></html>`;
}
