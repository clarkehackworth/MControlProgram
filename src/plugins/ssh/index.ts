/**
 * SSH plugin: MControlProgram holds the keys and makes the connections. Agents get exec, persistent
 * shells, and SFTP on hosts the admin configured — never the credentials.
 */
import ssh2, { type ConnectConfig, type ClientChannel, type SFTPWrapper } from 'ssh2';
const { Client, utils: sshUtils } = ssh2;
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { MControlProgramPlugin, PluginContext, PluginInstance, PluginActionContext, ToolResult } from '../../core/plugin-api.js';
import { effective } from '../../core/global-config.js';
import { text, errorResult } from '../../core/plugin-api.js';
import { pluginConfig } from '../../core/store.js';
import { localClient } from './local.js';
import * as cmdRules from './rules.js';

export interface HostCfg {
  name: string; host: string; port?: number; username: string; auth: 'key' | 'password' | 'agent' | 'native';
  privateKey?: string; passphrase?: string; password?: string; description?: string; hostKey?: string;
  allowCommands?: string[]; denyCommands?: string[]; allowShell?: boolean; allowSftp?: boolean; sftpRoot?: string;
}
interface GlobalCfg { hosts: HostCfg[]; connectTimeoutMs: number; keepaliveSec: number }
interface Cfg { hosts: string[]; hostsDisabled?: string[]; execTimeoutMs: number; maxOutputBytes: number; idleDisconnectSec: number; shellIdleSec: number; shellScope: 'principal' | 'session' | 'shared' }
/** Resolved per-instance view: selected host objects + merged settings. */
type Resolved = Omit<Cfg, 'hosts'> & Omit<GlobalCfg, 'hosts'> & { hosts: HostCfg[] }

const hostSchema = {
  type: 'object', required: ['name', 'auth'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'Identifier agents use (e.g. "prod-web-1")' },
    description: { type: 'string', title: 'Description', description: 'Shown to agents in list_hosts' },
    host: { type: 'string', title: 'Hostname / IP', 'x-show-if': { auth: ['key', 'password', 'agent'] } },
    port: { type: 'integer', title: 'Port', default: 22, 'x-show-if': { auth: ['key', 'password', 'agent'] } },
    hostKey: { type: 'string', title: 'Pinned host key (SHA256 fingerprint)', 'x-no-column': true, description: 'Set on the first "Test connection" (compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host) or paste it. Connections presenting a different key are refused. Clear to re-pin.' },
    username: { type: 'string', title: 'Username', 'x-show-if': { auth: ['key', 'password', 'agent'] } },
    auth: { type: 'string', title: 'Auth method', enum: ['key', 'password', 'agent', 'native'], default: 'key', description: 'native = no ssh: commands, shells and files are on the machine MControlProgram itself runs on (inside its container if containerised), as the user it runs as. Agents with access get that machine\'s privileges, including MControlProgram\'s own data; restrict with command patterns and an SFTP root.' },
    privateKey: { type: 'string', title: 'Private key (PEM)', format: 'multiline', 'x-secret': true, 'x-show-if': { auth: 'key' } },
    passphrase: { type: 'string', title: 'Key passphrase', 'x-secret': true, 'x-show-if': { auth: 'key' } },
    password: { type: 'string', title: 'Password', 'x-secret': true, 'x-show-if': { auth: 'password' } },
    allowCommands: { type: 'array', title: 'Allowed command patterns (regex)', description: 'If set, commands must match one. Empty = allow all.', items: { type: 'string' } },
    denyCommands: { type: 'array', title: 'Denied command patterns (regex)', description: 'Commands matching any are refused (checked before allow).', items: { type: 'string' } },
    allowShell: { type: 'boolean', title: 'Allow persistent shell sessions', default: true },
    allowSftp: { type: 'boolean', title: 'Allow SFTP', default: true },
    sftpRoot: { type: 'string', title: 'SFTP root', description: 'Restrict SFTP paths to this directory (optional)' },
  },
};

/** Plugin-wide: the host inventory and connection settings, shared by every ssh instance. */
const globalConfigSchema = {
  type: 'object',
  properties: {
    hosts: { type: 'array', title: 'SSH hosts', description: 'Hosts agents may be given access to. Use "Add host" for the guided setup (key generation, ssh-copy-id).', items: hostSchema },
    connectTimeoutMs: { type: 'integer', title: 'Connect timeout (ms)', default: 15000 },
    keepaliveSec: { type: 'integer', title: 'Keepalive interval (seconds)', default: 30 },
  },
};

/** Per-instance: which hosts this MCP server exposes, and runtime limits. */
const configSchema = {
  type: 'object',
  properties: {
    hosts: { type: 'array', title: 'Exposed hosts', description: 'Hosts from the plugin inventory that agents on this server may use. Empty = no hosts.', items: { type: 'string', 'x-options-from': 'hosts' }, 'x-disabled-key': 'hostsDisabled' },
    hostsDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true },
    shellScope: { type: 'string', title: 'Shell isolation', enum: ['principal', 'session', 'shared'], default: 'principal',
      description: 'principal: each token/OAuth client has its own shells (resumable after reconnect). session: shells die with the MCP session. shared: all agents see the same shells.' },
    execTimeoutMs: { type: 'integer', title: 'Exec timeout (ms)', default: 120000 },
    maxOutputBytes: { type: 'integer', title: 'Max output bytes per call', default: 200000 },
    shellIdleSec: { type: 'integer', title: 'Shell idle timeout (seconds)', description: 'Shells with neither input nor output for this long are closed. 0 = use the MControlProgram-wide state idle timeout (Settings).', default: 0 },
    idleDisconnectSec: { type: 'integer', title: 'Host idle disconnect (seconds)', description: 'Close the SSH socket after no activity; shells reopen on demand. 0 = use the MControlProgram-wide connection idle timeout (Settings).', default: 0 },
  },
};

// ---------- key helpers (used by the add-host wizard) ----------

function generateKeyPair(type: 'ed25519' | 'rsa', comment: string) {
  if (type === 'ed25519') {
    // ssh2 cannot parse PKCS8 ed25519, so use ssh-keygen's OpenSSH format (present wherever sshd/ssh is).
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-key-'));
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path.join(d, 'k')]);
      return { privateKey: fs.readFileSync(path.join(d, 'k'), 'utf8'), publicKey: fs.readFileSync(path.join(d, 'k.pub'), 'utf8').trim() };
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  return { privateKey, publicKey: publicKeyOf(privateKey, undefined, comment) };
}

function publicKeyOf(privateKey: string, passphrase?: string, comment?: string): string {
  const k = sshUtils.parseKey(privateKey, passphrase);
  if (k instanceof Error) throw new Error(`cannot parse private key: ${k.message}`);
  const key = Array.isArray(k) ? k[0]! : k;
  return `${key.type} ${key.getPublicSSH().toString('base64')}${comment ? ' ' + comment : ''}`;
}

function manualInstructions(h: HostCfg, publicKey: string) {
  return {
    publicKey,
    authorizedKeysPath: `~${h.username}/.ssh/authorized_keys  (usually /home/${h.username}/.ssh/authorized_keys, or /root/.ssh/authorized_keys for root)`,
    steps: [
      `Log in to ${h.host} as ${h.username} by any means you already have.`,
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      `echo '${publicKey}' >> ~/.ssh/authorized_keys`,
      'chmod 600 ~/.ssh/authorized_keys',
      'Then run "Test connection" for this host in MControlProgram.',
    ],
    oneLiner: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  };
}

class Conn {
  client = new Client();
  ready = false;
  lastUsed = Date.now();
  shells = new Map<string, { ch: ClientChannel; buf: string; owner: string; closed: boolean; lastUsed: number }>(); // keyed by scope-qualified shell name
  sftp?: SFTPWrapper;
  /** Fingerprint the server presented on this connection. */
  hostKey?: string;
  constructor(public host: HostCfg) {}
}

function connect(host: HostCfg, cfg: { connectTimeoutMs: number; keepaliveSec: number }, log: PluginContext['log']): Promise<Conn> {
  const c = new Conn(host);
  if (host.auth === 'native') { c.client = localClient() as unknown as InstanceType<typeof Client>; c.ready = true; return Promise.resolve(c); }
  const opts: ConnectConfig = {
    host: host.host, port: host.port ?? 22, username: host.username, readyTimeout: cfg.connectTimeoutMs, keepaliveInterval: cfg.keepaliveSec * 1000,
  };
  if (host.auth === 'key') { opts.privateKey = host.privateKey; opts.passphrase = host.passphrase || undefined; }
  else if (host.auth === 'password') opts.password = host.password;
  else opts.agent = process.env.SSH_AUTH_SOCK;
  opts.hostVerifier = (key: Buffer) => {
    c.hostKey = fingerprint(key);
    // ponytail: unpinned hosts are accepted with a warning so existing installs keep working; tunnels require a pin
    if (!host.hostKey) { log.warn(`ssh ${host.name}: host key not pinned (presented ${c.hostKey}); run "Test connection" to pin it`); return true; }
    return c.hostKey === host.hostKey;
  };
  return new Promise((resolve, reject) => {
    c.client.on('ready', () => { c.ready = true; log.connection(`ssh connected ${host.username}@${host.host}:${opts.port}`); resolve(c); });
    c.client.on('error', (e) => {
      if (!c.ready) reject(host.hostKey && c.hostKey && c.hostKey !== host.hostKey ? new Error(`host key mismatch for ${host.name}: pinned ${host.hostKey}, presented ${c.hostKey}. Refusing to connect.`) : e); else log.warn(`ssh error on ${host.name}: ${e.message}`); });
    c.client.on('close', () => { c.ready = false; log.connection(`ssh disconnected ${host.name}`); });
    c.client.connect(opts);
  });
}

function checkCommand(host: HostCfg, cmd: string) {
  for (const p of host.denyCommands ?? []) if (new RegExp(p).test(cmd)) throw new Error(`command denied by policy (${p})`);
  const allow = (host.allowCommands ?? []).filter(Boolean);
  if (allow.length && !allow.some((p) => new RegExp(p).test(cmd))) throw new Error('command not in allow list');
}

function sftpPath(host: HostCfg, p: string) {
  if (!host.sftpRoot) return p;
  const root = host.sftpRoot.replace(/\/+$/, '');
  const abs = p.startsWith('/') ? p : `${root}/${p}`;
  const norm = abs.split('/').reduce<string[]>((a, s) => (s === '..' ? (a.pop(), a) : s && s !== '.' ? [...a, s] : a), []).join('/');
  const full = '/' + norm;
  if (full !== root && !full.startsWith(root + '/')) throw new Error(`path outside sftp root ${root}`);
  return full;
}

// Strip OSC (title/shell-integration) and CSI (colour/cursor) sequences so agents get plain text.
const stripAnsi = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '');
/** Wait until the shell buffer has been quiet for `quietMs`, or `maxMs` elapsed. */
const settle = async (sh: { buf: string }, maxMs: number, quietMs = 250) => {
  const t0 = Date.now(); let last = sh.buf.length; let quietSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (sh.buf.length !== last) { last = sh.buf.length; quietSince = Date.now(); }
    else if (sh.buf.length > 0 && Date.now() - quietSince >= quietMs) break;
  }
};
/** OpenSSH-style fingerprint, same as `ssh-keygen -lf`. */
export const fingerprint = (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

/** Record the fingerprint seen on a trusted admin action, if the host has none yet (trust on first use). */
async function pin(a: PluginActionContext, name: string, hostKey?: string) {
  const g = a.config as GlobalCfg;
  if (!hostKey || g.hosts.find((x) => x.name === name)?.hostKey) return false;
  await a.setConfig({ ...g, hosts: g.hosts.map((x) => (x.name === name ? { ...x, hostKey } : x)) });
  a.log.info(`ssh host "${name}" host key pinned: ${hostKey}`);
  return true;
}

/**
 * Like `ssh -L`: listen on 127.0.0.1:<random> and carry each accepted connection over SSH to
 * remoteHost:remotePort as seen from `host`. The SSH session opens now (so errors surface) and reconnects on demand after drops.
 * Refuses hosts without a pinned host key, since tunnels typically carry credentials.
 */
export async function openTunnel(host: HostCfg, g: { connectTimeoutMs: number; keepaliveSec: number }, remoteHost: string, remotePort: number, log: PluginContext['log']) {
  if (host.auth === 'native') return { port: remotePort, close() {} }; // already local: the "tunnel" is the port itself
  if (!host.hostKey) throw new Error(`ssh host "${host.name}" has no pinned host key; run "Test connection" on it in the SSH plugin first`);
  let conn: Promise<Conn> | undefined;
  const getConn = () => {
    if (!conn) {
      const p = (conn = connect(host, g, log));
      const forget = () => { if (conn === p) conn = undefined; };
      p.then((c) => c.client.on('close', forget), forget);
    }
    return conn;
  };
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('error', () => {});
    getConn().then((c) => c.client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, ch) => {
      if (err) { log.warn(`tunnel ${host.name} → ${remoteHost}:${remotePort}: ${err.message}`); return sock.destroy(); }
      ch.on('error', () => sock.destroy()); sock.on('close', () => ch.close());
      sock.pipe(ch).pipe(sock);
    }), (e: Error) => { log.warn(`tunnel ${host.name}: ${e.message}`); sock.destroy(); });
  });
  await getConn(); // fail fast: auth / host-key errors surface to the caller, not as a reset socket later
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  log.connection(`tunnel 127.0.0.1:${(server.address() as net.AddressInfo).port} → ${host.name} → ${remoteHost}:${remotePort}`);
  return {
    port: (server.address() as net.AddressInfo).port,
    close() { server.close(); void conn?.then((c) => c.client.end(), () => {}); conn = undefined; },
  };
}

/** One-shot exec on a fresh connection (used by plugin-level actions). Also returns the presented host key. */
async function execOnce(host: HostCfg, g: { connectTimeoutMs: number; keepaliveSec: number }, cmd: string, log: PluginContext['log']) {
  const c = await connect(host, g, log);
  try {
    return await new Promise<{ stdout: string; stderr: string; code: number | null; hostKey?: string }>((resolve, reject) => {
      c.client.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        let out = '', errOut = '';
        ch.on('data', (d: Buffer) => (out += d.toString())); ch.stderr.on('data', (d: Buffer) => (errOut += d.toString()));
        ch.on('close', (code: number | null) => resolve({ stdout: out, stderr: errOut, code, hostKey: c.hostKey }));
      });
    });
  } finally { c.client.end(); }
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]` : s);

/**
 * What the ssh plugin offers to plugins that declare `dependencies: { ssh: '^0.2.0' }` (via `ctx.dep('ssh')`).
 * Hosts are looked up by name in the current inventory on every call and must have a pinned host key.
 */
export interface SshApi {
  hostNames(): string[];
  /** Run one command on a fresh connection. */
  exec(host: string, cmd: string, log: PluginContext['log']): Promise<{ stdout: string; stderr: string; code: number | null }>;
  /** `ssh -L` to remoteHost:remotePort as seen from `host`; see openTunnel. */
  openTunnel(host: string, remoteHost: string, remotePort: number, log: PluginContext['log']): Promise<{ port: number; close(): void }>;
}
const pinnedHost = (name: string) => {
  const g = { ...plugin.defaultGlobalConfig, ...pluginConfig.decrypted('ssh') } as GlobalCfg;
  const h = g.hosts.find((x) => x.name === name);
  if (!h) throw new Error(`ssh host "${name}" is not in the SSH plugin inventory`);
  if (!h.hostKey && h.auth !== 'native') throw new Error(`ssh host "${name}" has no pinned host key; run "Test connection" on it in the SSH plugin first`);
  return { h, g };
};
const api: SshApi = {
  hostNames: () => ((pluginConfig.decrypted('ssh').hosts ?? []) as HostCfg[]).map((h) => h.name),
  exec: (name, cmd, log) => { const { h, g } = pinnedHost(name); return execOnce(h, g, cmd, log); },
  openTunnel: (name, rh, rp, log) => { const { h, g } = pinnedHost(name); return openTunnel(h, g, rh, rp, log); },
};

const plugin: MControlProgramPlugin = {
  id: 'ssh', name: 'SSH', version: '0.2.0',
  api,
  description: 'Execute commands, run persistent shells, and transfer files over SSH on admin-configured hosts.',
  configSchema,
  defaultConfig: { hosts: [], execTimeoutMs: 120000, maxOutputBytes: 200000, idleDisconnectSec: 0, shellIdleSec: 0, shellScope: 'principal' },
  globalConfigSchema,
  defaultGlobalConfig: { hosts: [], connectTimeoutMs: 15000, keepaliveSec: 30 },

  globalActions: {
    ...cmdRules.actions,
    add_host: {
      title: 'Add host',
      /**
       * Wizard step 1. params: { name, host, port?, username, description?, auth: 'password'|'key'|'agent',
       *   password?, keySource?: 'generate'|'manual', keyType?: 'ed25519'|'rsa', privateKey?, passphrase? }
       * Stores the host (generating a key pair if asked) and returns the public key + manual install instructions.
       * The private key never leaves MControlProgram.
       */
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const name = String(p.name ?? '').trim();
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('name must be letters, digits, dot, dash or underscore');
        if (g.hosts.some((h) => h.name === name)) throw new Error(`host "${name}" already exists`);
        if (p.auth !== 'native' && (!p.host || !p.username)) throw new Error('host and username are required');
        const h: HostCfg = { name, host: String(p.host ?? ''), port: Number(p.port) || 22, username: String(p.username ?? ''), description: p.description ? String(p.description) : undefined, auth: p.auth === 'password' ? 'password' : p.auth === 'agent' ? 'agent' : p.auth === 'native' ? 'native' : 'key', allowShell: true, allowSftp: true };
        let publicKey: string | undefined;
        if (h.auth === 'password') {
          if (!p.password) throw new Error('password is required');
          h.password = String(p.password);
        } else if (h.auth === 'key') {
          if (p.keySource === 'manual') {
            if (!p.privateKey) throw new Error('private key is required');
            h.privateKey = String(p.privateKey); h.passphrase = p.passphrase ? String(p.passphrase) : undefined;
            publicKey = publicKeyOf(h.privateKey, h.passphrase, `mcontrolprogram-${name}`);
          } else {
            const kp = generateKeyPair(p.keyType === 'rsa' ? 'rsa' : 'ed25519', `mcontrolprogram-${name}`);
            h.privateKey = kp.privateKey; publicKey = kp.publicKey;
          }
        }
        await a.setConfig({ ...g, hosts: [...g.hosts, h] });
        a.log.info(`ssh host "${name}" added (${h.auth}${publicKey ? ', key ' + publicKey.split(' ')[0] : ''})`);
        return { name, auth: h.auth, ...(publicKey ? manualInstructions(h, publicKey) : {}) };
      },
    },
    copy_id: {
      title: 'Install key with password (ssh-copy-id)',
      /** Wizard step 2 (optional). params: { name, password }. Logs in with the password once, appends the public key, then verifies key login. */
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === p.name);
        if (!h) throw new Error('unknown host');
        if (!h.privateKey) throw new Error('host has no private key configured');
        if (!p.password) throw new Error('password is required');
        const publicKey = publicKeyOf(h.privateKey, h.passphrase, `mcontrolprogram-${h.name}`);
        const r = await execOnce({ ...h, auth: 'password', password: String(p.password) }, g,
          `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF '${publicKey}' ~/.ssh/authorized_keys || echo '${publicKey}' >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; echo installed`, a.log);
        if (!/installed/.test(r.stdout)) throw new Error(`could not install key: ${r.stderr || r.stdout || 'exit ' + r.code}`);
        await pin(a, h.name, r.hostKey);
        const t = await execOnce({ ...h, hostKey: h.hostKey ?? r.hostKey }, g, 'echo ok', a.log);
        a.log.info(`ssh public key installed on ${h.name} via password`);
        return { installed: true, keyLogin: t.stdout.trim() === 'ok' };
      },
    },
    remove_key: {
      title: 'Remove key from host',
      /** params: { name, password? }. Deletes this host's public key from the remote ~/.ssh/authorized_keys, logging in with the key (or the password if given). */
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === p.name);
        if (!h) throw new Error('unknown host');
        if (!h.privateKey) throw new Error('host has no private key configured');
        const blob = publicKeyOf(h.privateKey, h.passphrase, `mcontrolprogram-${h.name}`).split(' ')[1];
        const login = p.password ? { ...h, auth: 'password' as const, password: String(p.password) } : h;
        const f = '~/.ssh/authorized_keys';
        const r = await execOnce(login, g, `grep -vF '${blob}' ${f} > ${f}.mcp; cat ${f}.mcp > ${f}; rm -f ${f}.mcp; echo removed`, a.log);
        if (!/removed/.test(r.stdout)) throw new Error(`could not remove key: ${r.stderr || r.stdout || 'exit ' + r.code}`);
        a.log.info(`ssh public key removed from ${h.name}`);
        return { removed: true };
      },
    },
    test_host: {
      title: 'Test connection',
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === p.name); if (!h) throw new Error('unknown host');
        const t0 = Date.now(); const r = await execOnce(h, g, 'echo ok; uname -a', a.log);
        const pinned = await pin(a, h.name, r.hostKey);
        return { ok: r.stdout.startsWith('ok'), ms: Date.now() - t0, uname: r.stdout.split('\n')[1] ?? '', hostKey: r.hostKey, ...(pinned ? { pinned: 'host key pinned on first use; verify it matches the server' } : {}) };
      },
    },
    public_key: {
      title: 'Show public key',
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        const h = g.hosts.find((x) => x.name === p.name); if (!h) throw new Error('unknown host');
        if (!h.privateKey) throw new Error('host uses ' + h.auth + ' auth; no key stored');
        return manualInstructions(h, publicKeyOf(h.privateKey, h.passphrase, `mcontrolprogram-${h.name}`));
      },
    },
    remove_host: {
      title: 'Remove host',
      async run(p, a: PluginActionContext) {
        const g = a.config as GlobalCfg;
        if (!g.hosts.some((x) => x.name === p.name)) throw new Error('unknown host');
        await a.setConfig({ ...g, hosts: g.hosts.filter((x) => x.name !== p.name) });
        return { removed: p.name };
      },
    },
  },

  create(ctx: PluginContext): PluginInstance {
    const g = ctx.pluginConfig as GlobalCfg;
    const off = (ctx.config.hostsDisabled as string[] | undefined) ?? [];
    const selected = ((ctx.config.hosts as string[] | undefined) ?? []).filter((n) => !off.includes(n));
    const cfg: Resolved = { ...g, ...(ctx.config as Cfg), hosts: g.hosts.filter((h) => selected.includes(h.name)) };
    for (const n of selected) if (!g.hosts.some((h) => h.name === n)) ctx.log.warn(`selected host "${n}" is not in the plugin inventory`);
    const conns = new Map<string, Promise<Conn>>();
    let idleTimer: NodeJS.Timeout | undefined;
    const hostByName = (n: string) => {
      const h = cfg.hosts.find((h) => h.name === n);
      if (!h) throw new Error(`unknown host "${n}". Use list_hosts.`);
      return h;
    };
    const getConn = async (name: string): Promise<Conn> => {
      const host = hostByName(name);
      let p = conns.get(name);
      if (p) {
        const c = await p.catch(() => undefined);
        if (c?.ready) { c.lastUsed = Date.now(); return c; }
        conns.delete(name);
      }
      p = connect(host, cfg, ctx.log);
      conns.set(name, p);
      p.catch(() => conns.delete(name));
      return p;
    };
    const disconnect = async (name: string) => {
      const p = conns.get(name); conns.delete(name);
      const c = await p?.catch(() => undefined);
      if (c) { for (const s of c.shells.values()) s.ch.close(); c.client.end(); }
    };
    const exec = (c: Conn, cmd: string, signal: AbortSignal, timeoutMs?: number) => (c.lastUsed = Date.now(),
      new Promise<{ stdout: string; stderr: string; code: number | null; signal?: string }>((resolve, reject) => {
        c.client.exec(cmd, (err, ch) => {
          if (err) return reject(err);
          let out = '', errOut = '';
          const timer = setTimeout(() => { ch.close(); reject(new Error(`exec timed out after ${timeoutMs ?? cfg.execTimeoutMs}ms`)); }, timeoutMs ?? cfg.execTimeoutMs);
          signal.addEventListener('abort', () => { ch.close(); clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
          ch.on('data', (d: Buffer) => { if (out.length < cfg.maxOutputBytes * 2) out += d.toString(); });
          ch.stderr.on('data', (d: Buffer) => { if (errOut.length < cfg.maxOutputBytes * 2) errOut += d.toString(); });
          ch.on('close', (code: number | null, sig?: string) => { clearTimeout(timer); resolve({ stdout: out, stderr: errOut, code, signal: sig }); });
        });
      }));
    const getSftp = (c: Conn) => new Promise<SFTPWrapper>((resolve, reject) => {
      if (c.sftp) return resolve(c.sftp);
      c.client.sftp((err, s) => { if (err) return reject(err); c.sftp = s; s.on('close', () => (c.sftp = undefined)); resolve(s); });
    });
    /** Plugin-wide command rules, then the host's own patterns. Throws (and logs) if refused. */
    const who = (c: { principal?: string }) => ({ serverId: ctx.serverId, instance: ctx.instanceName, principal: c.principal });
    const log = (e: Omit<cmdRules.LogEntry, 'serverId' | 'instance' | 'principal'>, c: { principal?: string }) => {
      try { cmdRules.record({ ...who(c), ...e }); } catch (err) { ctx.log.warn(`command log write failed: ${(err as Error).message}`); }
    };
    const admit = (h: HostCfg, tool: string, cmd: string, c: { principal?: string }) => {
      const v = cmdRules.verdict(cmd, h.name, cmdRules.rules(), cmdRules.policy());
      if (v.blocked) {
        log({ host: h.name, tool, command: cmd, blocked: v.blocked }, c);
        throw new Error(v.blocked === 'default: deny' ? 'command not on the administrator\'s allow list' : `command blocked by administrator (${v.blocked})`);
      }
      try { checkCommand(h, cmd); } catch (e) { log({ host: h.name, tool, command: cmd, blocked: `host policy: ${(e as Error).message}` }, c); throw e; }
      return v.allowedBy;
    };
    const hostArg = z.string().describe('Host name from list_hosts');
    const shellName = z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Shell name (default "default"); use different names for parallel shells on one host');
    // Shell key = scope qualifier + name. Agents only ever see their own qualifier's shells.
    const scopeKey = (c: { sessionId?: string; principal?: string }) =>
      cfg.shellScope === 'shared' ? 'shared' : cfg.shellScope === 'session' ? `session:${c.sessionId ?? 'none'}` : `principal:${c.principal ?? 'anonymous'}`;
    const closeShell = (conn: Conn, key: string, why: string) => {
      const sh = conn.shells.get(key); if (!sh) return false;
      sh.ch.close(); conn.shells.delete(key);
      ctx.log.connection(`shell closed ${conn.host.name}/${key} (${why})`);
      return true;
    };
    const getShell = async (host: string, name: string, c: { sessionId?: string; principal?: string }) => {
      const h = hostByName(host);
      const conn = await getConn(host);
      const key = `${scopeKey(c)}/${name}`;
      const existing = conn.shells.get(key);
      if (existing && !existing.closed) { existing.lastUsed = Date.now(); return { conn, sh: existing, id: name, opened: false }; }
      if (existing) conn.shells.delete(key);
      if (h.allowShell === false) throw new Error('shell sessions are disabled for this host');
      const ch = await new Promise<ClientChannel>((res, rej) => conn.client.shell({ term: 'xterm-256color', cols: 160, rows: 48 }, (e, s) => (e ? rej(e) : res(s))));
      const sh = { ch, buf: '', owner: scopeKey(c), closed: false, lastUsed: Date.now() };
      // Any output counts as activity: a long-running job that is still printing is never reaped.
      const onData = (d: Buffer) => { sh.buf += d.toString(); sh.lastUsed = conn.lastUsed = Date.now(); if (sh.buf.length > cfg.maxOutputBytes * 4) sh.buf = sh.buf.slice(-cfg.maxOutputBytes * 2); };
      ch.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('close', () => { sh.closed = true; });
      conn.shells.set(key, sh);
      ctx.log.connection(`shell opened ${host}/${key}`, undefined, c.sessionId);
      await settle(sh, 3000, 400);
      return { conn, sh, id: name, opened: true };
    };
    return {
      start() {
        // Reaper: closes idle/dead shells, then idle host connections. Runs regardless of agent behaviour.
        idleTimer = setInterval(async () => {
          const now = Date.now();
          try { cmdRules.prune(ctx.global().logRetentionDays); } catch { /* db closed */ }
          const shellIdle = effective(cfg.shellIdleSec, ctx.global().stateIdleSec), connIdle = effective(cfg.idleDisconnectSec, ctx.global().connectionIdleSec);
          for (const [name, p] of conns) {
            const c = await p.catch(() => undefined);
            if (!c) continue;
            for (const [key, sh] of c.shells) {
              if (sh.closed) closeShell(c, key, 'remote closed');
              else if (now - sh.lastUsed > shellIdle * 1000) closeShell(c, key, 'idle');
            }
            const lastActivity = Math.max(c.lastUsed, ...[...c.shells.values()].map((x) => x.lastUsed));
            if (now - lastActivity > connIdle * 1000) { ctx.log.connection(`idle disconnect ${name}`); await disconnect(name); }
            else if (!c.ready) { await disconnect(name); }
          }
        }, 15_000);
      },
      async stop() {
        if (idleTimer) clearInterval(idleTimer);
        for (const name of [...conns.keys()]) await disconnect(name);
      },
      async onSessionClosed(sessionId) {
        if (cfg.shellScope !== 'session') return;
        for (const p of conns.values()) {
          const c = await p.catch(() => undefined);
          for (const key of c?.shells.keys() ?? []) if (key.startsWith(`session:${sessionId}/`)) closeShell(c!, key, 'agent session ended');
        }
      },
      async status() {
        const out: Record<string, unknown> = {};
        for (const [name, p] of conns) { const c = await p.catch(() => undefined); out[name] = c ? { connected: c.ready, shells: c.shells.size, lastUsed: c.lastUsed } : 'connecting'; }
        return { hosts: cfg.hosts.map((h) => h.name), shellScope: cfg.shellScope, shellIdleSec: effective(cfg.shellIdleSec, ctx.global().stateIdleSec), connectionIdleSec: effective(cfg.idleDisconnectSec, ctx.global().connectionIdleSec), connections: out };
      },
      actions: {
        testAll: { title: 'Test all connections', async run() {
          const results: Record<string, string> = {};
          for (const h of cfg.hosts) {
            try { const c = await getConn(h.name); const r = await exec(c, 'echo ok', AbortSignal.timeout(10000), 10000); results[h.name] = r.stdout.trim() === 'ok' ? 'ok' : `unexpected: ${r.stdout}`; }
            catch (e) { results[h.name] = `error: ${(e as Error).message}`; }
          }
          return results;
        } },
        disconnectAll: { title: 'Disconnect all', async run() { for (const n of [...conns.keys()]) await disconnect(n); return { ok: true }; } },
      },
      tools: [
        {
          name: 'list_hosts', description: 'List SSH hosts available through this gateway and what each allows.',
          annotations: { readOnlyHint: true },
          handler: async () => text(JSON.stringify(cfg.hosts.map((h) => ({
            name: h.name, description: h.description, ...(h.auth === 'native' ? { native: true } : { user: h.username, host: h.host, port: h.port ?? 22 }),
            shell: h.allowShell !== false, sftp: h.allowSftp !== false, sftpRoot: h.sftpRoot, commandPolicy: { allow: h.allowCommands ?? [], deny: h.denyCommands ?? [] },
            connected: conns.has(h.name),
          })), null, 2)),
        },
        {
          name: 'exec', description: 'Run a single command on a host and return stdout, stderr and exit code. Connections are reused.',
          inputSchema: { host: hostArg, command: z.string().describe('Shell command line'), timeoutMs: z.number().int().positive().optional().describe('Override exec timeout') },
          handler: async ({ host, command, timeoutMs }, c) => {
            try {
              const h = hostByName(host); const allowedBy = admit(h, 'exec', command, c);
              const conn = await getConn(host);
              c.log.connection(`exec on ${host}: ${command.slice(0, 200)}`, undefined, c.sessionId);
              const t0 = Date.now();
              const r = await exec(conn, command, c.signal, timeoutMs).catch((e) => { log({ host, tool: 'exec', command, allowedBy, error: (e as Error).message, ms: Date.now() - t0 }, c); throw e; });
              log({ host, tool: 'exec', command, allowedBy, exitCode: r.code, error: r.signal ? `signal ${r.signal}` : undefined, ms: Date.now() - t0 }, c);
              const body = `${clip(r.stdout, cfg.maxOutputBytes)}${r.stderr ? `\n[stderr]\n${clip(r.stderr, cfg.maxOutputBytes)}` : ''}\n[exit ${r.code ?? r.signal ?? '?'}]`;
              return { content: [{ type: 'text', text: body }], isError: r.code !== 0, structuredContent: { exitCode: r.code, stdout: clip(r.stdout, cfg.maxOutputBytes), stderr: clip(r.stderr, cfg.maxOutputBytes) } };
            } catch (e) { return errorResult(e); }
          },
        },
        {
          name: 'test_connection', description: 'Check that a host is reachable and authentication works (every other tool connects on demand; this is only a health check).',
          annotations: { readOnlyHint: true }, inputSchema: { host: hostArg },
          handler: async ({ host }, c) => { try { const r = await exec(await getConn(host), 'echo ok', c.signal, 10000); return text(r.stdout.trim() === 'ok' ? `${host}: ok` : `${host}: unexpected output ${r.stdout}`); } catch (e) { return errorResult(e); } },
        },
        {
          name: 'disconnect', description: 'Close all of your shells on a host. The underlying connection is shared with other agents and is reaped automatically when idle. Idempotent.',
          inputSchema: { host: hostArg },
          handler: async ({ host }, c) => {
            const conn = await conns.get(host)?.catch(() => undefined);
            let n = 0; const mine = scopeKey(c) + '/';
            for (const key of [...(conn?.shells.keys() ?? [])]) if (key.startsWith(mine) && closeShell(conn!, key, 'closed by agent')) n++;
            if (conn && conn.shells.size === 0 && cfg.shellScope === 'shared') await disconnect(host);
            return text(`closed ${n} shell(s) on ${host}`);
          },
        },
        {
          name: 'shell_send',
          description: 'Send a line to a persistent interactive shell on a host and return its output. Shells are addressed by host + name and are opened on demand: no prior call is needed. State (cwd, env, background jobs) persists between calls to the same host/name.',
          inputSchema: { host: hostArg, name: shellName, input: z.string().describe('Command line; newline appended unless raw=true'), waitMs: z.number().int().min(0).max(300000).optional().describe('Max time to wait for output to settle (default 5000); returns earlier once output goes quiet'), raw: z.boolean().optional().describe('Send keystrokes verbatim (e.g. "\\x03" for Ctrl-C); bypasses the newline, not the command policy check') },
          handler: async ({ host, name, input, waitMs, raw }, c) => {
            try {
              const h = hostByName(host);
              const allowedBy = admit(h, 'shell', input, c);
              const { conn, sh, id, opened } = await getShell(host, name ?? 'default', c);
              log({ host, tool: 'shell', command: input, allowedBy }, c);
              sh.buf = '';
              sh.ch.write(raw ? input : input + '\n');
              conn.lastUsed = sh.lastUsed = Date.now();
              c.log.connection(`shell ${id} <- ${input.slice(0, 200)}`, undefined, c.sessionId);
              await settle(sh, waitMs ?? 5000);
              return text((opened ? `[shell ${id} opened]\n` : '') + clip(stripAnsi(sh.buf), cfg.maxOutputBytes) + (sh.closed ? '\n[shell closed]' : ''));
            } catch (e) { return errorResult(e); }
          },
        },
        {
          name: 'shell_read', description: 'Read output accumulated in a shell since the last call (for long-running commands). Opens the shell if it does not exist.',
          inputSchema: { host: hostArg, name: shellName, waitMs: z.number().int().min(0).max(60000).optional() },
          handler: async ({ host, name, waitMs }, c) => {
            try {
              const { sh, id, opened } = await getShell(host, name ?? 'default', c);
              if (waitMs) await settle(sh, waitMs);
              const out = stripAnsi(sh.buf); sh.buf = '';
              return text((opened ? `[shell ${id} opened]\n` : '') + clip(out, cfg.maxOutputBytes) + (sh.closed ? '\n[shell closed]' : ''));
            } catch (e) { return errorResult(e); }
          },
        },
        {
          name: 'shell_list', description: 'List your open shells (host + name).', annotations: { readOnlyHint: true },
          handler: async (_a, c) => {
            const out: string[] = []; const mine = scopeKey(c) + '/';
            for (const [host, p] of conns) {
              const conn = await p.catch(() => undefined);
              for (const [key, sh] of conn?.shells ?? []) if (key.startsWith(mine)) out.push(`${host}/${key.slice(mine.length)} idle ${Math.round((Date.now() - sh.lastUsed) / 1000)}s${sh.closed ? ' (closed)' : ''}`);
            }
            return text(out.join('\n') || '(no open shells)');
          },
        },
        {
          name: 'shell_close', description: 'Close a shell session. Idempotent.',
          inputSchema: { host: hostArg, name: shellName },
          handler: async ({ host, name }, c) => {
            const conn = await conns.get(host)?.catch(() => undefined);
            const ok = conn ? closeShell(conn, `${scopeKey(c)}/${name ?? 'default'}`, 'closed by agent') : false;
            return text(ok ? `closed ${host}/${name ?? 'default'}` : 'shell was not open');
          },
        },
        {
          name: 'sftp_list', description: 'List a directory over SFTP.', annotations: { readOnlyHint: true },
          inputSchema: { host: hostArg, path: z.string() },
          handler: async ({ host, path }, _c) => {
            try {
              const h = hostByName(host); if (h.allowSftp === false) throw new Error('sftp disabled for this host');
              const s = await getSftp(await getConn(host));
              const p = sftpPath(h, path); log({ host, tool: 'sftp_list', command: p }, _c);
              const list = await new Promise<any[]>((res, rej) => s.readdir(p, (e, l) => (e ? rej(e) : res(l))));
              return text(list.map((e) => `${e.longname}`).join('\n') || '(empty)');
            } catch (e) { return errorResult(e); }
          },
        },
        {
          name: 'sftp_read', description: 'Read a file over SFTP (text; truncated at max output size).', annotations: { readOnlyHint: true },
          inputSchema: { host: hostArg, path: z.string() },
          handler: async ({ host, path }, _c) => {
            try {
              const h = hostByName(host); if (h.allowSftp === false) throw new Error('sftp disabled for this host');
              const s = await getSftp(await getConn(host));
              const p = sftpPath(h, path); log({ host, tool: 'sftp_read', command: p }, _c);
              const buf = await new Promise<Buffer>((res, rej) => s.readFile(p, (e, d) => (e ? rej(e) : res(d))));
              return text(clip(buf.toString('utf8'), cfg.maxOutputBytes));
            } catch (e) { return errorResult(e); }
          },
        },
        {
          name: 'sftp_write', description: 'Write a text file over SFTP (creates or overwrites).', annotations: { destructiveHint: true },
          inputSchema: { host: hostArg, path: z.string(), content: z.string(), mode: z.number().int().optional().describe('e.g. 420 for 0644') },
          handler: async ({ host, path, content, mode }, c) => {
            try {
              const h = hostByName(host); if (h.allowSftp === false) throw new Error('sftp disabled for this host');
              const s = await getSftp(await getConn(host));
              const p = sftpPath(h, path);
              await new Promise<void>((res, rej) => s.writeFile(p, Buffer.from(content, 'utf8'), mode ? { mode } : {}, (e) => (e ? rej(e) : res())));
              c.log.connection(`sftp write ${host}:${p} (${content.length} bytes)`, undefined, c.sessionId);
              log({ host, tool: 'sftp_write', command: `${p} (${content.length} bytes)` }, c);
              return text(`wrote ${content.length} bytes to ${p}`);
            } catch (e) { return errorResult(e); }
          },
        },
      ] satisfies PluginInstance['tools'],
    };
  },
};

export default plugin;
export type { ToolResult };
