/**
 * Docker Sandboxes (`sbx` CLI) on SSH hosts: list, create and remove sandboxes, run commands and move files in
 * them, publish ports, and read or change their network policy. Everything is one `sbx …` command over ssh.
 */
import path from 'node:path';
import { z } from 'zod';
import type { MControlProgramPlugin, PluginContext, PluginInstance, PluginActionContext, ToolDefinition, ToolCallContext } from '../../core/plugin-api.js';
import { text } from '../../core/plugin-api.js';
import type { SshApi } from '../ssh/index.js';

interface HostCfg { name: string; sshHost: string; description?: string; workspaceRoots?: string[]; sbx?: string }
interface GlobalCfg { hosts: HostCfg[]; maxOutputBytes: number }
interface Cfg { hosts: string[]; hostsDisabled?: string[] }

const SANDBOX = /^[A-Za-z0-9][A-Za-z0-9.-]+$/;
const AGENTS = ['shell', 'claude', 'codex', 'cursor', 'devin', 'docker-agent', 'gemini', 'opencode'] as const;
// ponytail: the whole file travels base64 inside the ssh command line, which Linux caps at 128 KiB per argument.
// Use `copy` from a workspace root for bigger files.
export const MAX_WRITE = 90_000;

/** Single-quote for sh. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function sandboxName(s: unknown): string {
  const n = String(s ?? '');
  if (!SANDBOX.test(n)) throw new Error(`invalid sandbox name "${n}": letters, digits, - and .`);
  return n;
}

/**
 * A path on the ssh host that copy/create may touch: absolute, normalised, inside one of the host's workspace roots.
 * ponytail: lexical check only; a symlink inside a root that points out of it is followed. Keep roots free of
 * links you don't trust (or add a `realpath` round-trip if agents can create links there).
 */
export function hostPath(h: Pick<HostCfg, 'name' | 'workspaceRoots'>, p: unknown): string {
  const roots = (h.workspaceRoots ?? []).filter(Boolean).map((r) => path.posix.normalize(r).replace(/\/+$/, '') || '/');
  if (!roots.length) throw new Error(`host "${h.name}" has no workspace roots: host file access is off`);
  const s = String(p ?? '');
  if (!s.startsWith('/')) throw new Error(`host path must be absolute: "${s}"`);
  if (s.includes(':') || /[\0\n]/.test(s)) throw new Error(`host path may not contain ':' or control characters: "${s}"`);
  const n = path.posix.normalize(s).replace(/(.)\/+$/, '$1');
  if (!roots.some((r) => r === '/' || n === r || n.startsWith(r + '/'))) throw new Error(`host path "${n}" is outside the workspace roots (${roots.join(', ')})`);
  return n;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]` : s);

const hostSchema = {
  type: 'object',
  required: ['name', 'sshHost'],
  properties: {
    name: { type: 'string', title: 'Name', pattern: '^[a-zA-Z0-9_.-]+$', 'x-pattern-hint': 'letters, digits, _ . -' },
    sshHost: { type: 'string', title: 'SSH host', description: 'Host from the SSH plugin inventory (pinned host key) where the sbx CLI is installed and logged in.', 'x-options-from': 'ssh:hosts' },
    description: { type: 'string', title: 'Description', description: 'Shown to agents' },
    workspaceRoots: { type: 'array', title: 'Workspace roots', 'x-no-column': true, description: 'Absolute directories on the host that agents may mount into new sandboxes and copy files to/from. Empty = no host file access (sandbox-internal files still work).', items: { type: 'string' }, default: [] },
    sbx: { type: 'string', title: 'sbx binary', 'x-no-column': true, description: 'Empty = sbx (on PATH)' },
  },
};

const plugin: MControlProgramPlugin = {
  id: 'sandbox',
  name: 'Docker Sandboxes',
  version: '0.1.0',
  description: 'Manage Docker Sandboxes (sbx) on SSH hosts: list, create and remove sandboxes, run commands, read/write and copy files, publish ports, and inspect or change their network policy.',
  dependencies: { ssh: '^0.2.0' },
  globalConfigSchema: {
    type: 'object',
    properties: {
      hosts: { type: 'array', title: 'Sandbox hosts', items: hostSchema, default: [] },
      maxOutputBytes: { type: 'integer', title: 'Max output (bytes)', default: 200000 },
    },
  },
  defaultGlobalConfig: { hosts: [], maxOutputBytes: 200000 },
  globalActions: {
    // The admin page: run any tool on any host. Same code path as agents, minus the gateway's tool rules.
    call: {
      title: 'Run tool', hidden: true,
      async run({ tool, args }, a: PluginActionContext) {
        const g = { ...plugin.defaultGlobalConfig, ...a.config } as GlobalCfg;
        const t = makeTools(a.dep<SshApi>('ssh'), g, g.hosts ?? []).find((x) => x.name === tool);
        if (!t) throw new Error(`unknown tool ${tool}`);
        const r = await t.handler(z.object(t.inputSchema ?? {}).parse(args ?? {}), { log: a.log, signal: AbortSignal.timeout(600_000) } as ToolCallContext);
        const out = r.content.map((c: any) => c.text ?? '').join('');
        if (r.isError) throw new Error(out);
        try { return JSON.parse(out); } catch { return out; }
      },
    },
    check_host: {
      title: 'Check host', inventory: 'hosts',
      async run({ name }, a: PluginActionContext) {
        const h = ((a.config as GlobalCfg).hosts ?? []).find((x) => x.name === name);
        if (!h) throw new Error('unknown host');
        const r = await a.dep<SshApi>('ssh').exec(h.sshHost, `${h.sbx || 'sbx'} version && ${h.sbx || 'sbx'} ls -q`, a.log);
        return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
      },
    },
  },
  configSchema: {
    type: 'object',
    properties: {
      hosts: { type: 'array', title: 'Hosts to expose', description: 'Empty = none. Use the server\'s Tool rules to allow, ask or deny each tool (e.g. ask for network_allow, deny remove).', items: { type: 'string', 'x-options-from': 'hosts' }, 'x-disabled-key': 'hostsDisabled', default: [] },
      hostsDisabled: { type: 'array', items: { type: 'string' }, 'x-hidden': true, default: [] },
    },
  },
  defaultConfig: { hosts: [] },

  create(ctx: PluginContext): PluginInstance {
    const cfg = ctx.config as Cfg;
    const g = { ...plugin.defaultGlobalConfig, ...ctx.pluginConfig } as GlobalCfg;
    const active = (cfg.hosts ?? []).filter((n) => !(cfg.hostsDisabled ?? []).includes(n));
    const hosts = g.hosts.filter((h) => active.includes(h.name));
    return { tools: makeTools(ctx.dep<SshApi>('ssh'), g, hosts), status: () => ({ hosts: hosts.map((h) => h.name) }) };
  },
};

/** The agent tools over `hosts`. The admin page calls the same tools (over every host) through the `call` action. */
function makeTools(ssh: SshApi, g: GlobalCfg, hosts: HostCfg[]): ToolDefinition[] {
    const names = hosts.map((h) => h.name);
    const one = names.length === 1;

    const pick = (name?: string) => {
      const n = name ?? (one ? names[0] : undefined);
      const h = hosts.find((x) => x.name === n);
      if (!h) throw new Error(n ? `host "${n}" is not available here; one of: ${names.join(', ')}` : `host is required; one of: ${names.join(', ')}`);
      return h;
    };
    const run = async (h: HostCfg, args: string, call: ToolCallContext, stdinB64?: string, okCodes = [0]) => {
      const cmd = (stdinB64 !== undefined ? `printf %s ${q(stdinB64)} | base64 -d | ` : '') + `${h.sbx || 'sbx'} ${args}`;
      call.log.connection(`sandbox ${h.name}: sbx ${args.slice(0, 200)}`, undefined, call.sessionId);
      const r = await ssh.exec(h.sshHost, cmd, call.log);
      const out = clip(r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''), g.maxOutputBytes);
      const ok = okCodes.includes(r.code ?? -1);
      return { content: [{ type: 'text' as const, text: ok ? out || 'ok' : `exit ${r.code}\n${out}` }], isError: !ok };
    };

    const hostArg = { host: (one ? z.string().optional() : z.string()).describe(`Sandbox host: ${names.join(', ')}${one ? ' (optional)' : ''}. See the hosts tool.`) };
    const sb = z.string().describe('Sandbox name (from list)');
    const ro = { readOnlyHint: true };
    const tool = <T extends z.ZodRawShape>(d: ToolDefinition<T>) => d as unknown as ToolDefinition;

    const tools: ToolDefinition[] = [
      tool({ name: 'hosts', description: 'Sandbox hosts available to you and the host directories (workspace roots) you may mount or copy to/from.', annotations: ro, inputSchema: {},
        handler: () => text(JSON.stringify(hosts.map((h) => ({ host: h.name, description: h.description, workspaceRoots: h.workspaceRoots ?? [] })), null, 2)) }),
      tool({ name: 'list', description: 'List sandboxes (name, agent, status, published ports, workspaces) as JSON.', annotations: ro, inputSchema: { ...hostArg },
        handler: (a, c) => run(pick(a.host), 'ls --json', c) }),
      tool({ name: 'create',
        description: 'Create a sandbox (microVM) for an agent kit. workspaces are host directories (inside a workspace root) mounted at the same path; mark read-only ones ro (the first must be read/write). The sandbox starts with the host\'s default network policy; see policy.',
        inputSchema: { ...hostArg, agent: z.enum(AGENTS).default('shell'), name: sb,
          workspaces: z.array(z.object({ path: z.string(), readOnly: z.boolean().optional() })).default([]),
          publish: z.array(z.string()).default([]).describe('[[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL]'),
          cpus: z.number().int().min(0).optional(), memory: z.string().regex(/^\d+[kmgKMG]?$/).optional().describe('e.g. 4g'),
          denyNetwork: z.array(z.string()).default([]).describe('Hosts to deny for this sandbox from the start') },
        handler: (a, c) => {
          const h = pick(a.host);
          const ws = a.workspaces.map((w: { path: string; readOnly?: boolean }) => q(hostPath(h, w.path) + (w.readOnly ? ':ro' : '')));
          const flags = [`--name ${q(sandboxName(a.name))}`, '--no-progress', ...a.publish.map((p: string) => `-p ${q(p)}`), ...a.denyNetwork.map((d: string) => `--deny-network ${q(d)}`),
            a.cpus !== undefined ? `--cpus ${a.cpus}` : '', a.memory ? `-m ${q(a.memory)}` : ''].filter(Boolean);
          return run(h, `create ${flags.join(' ')} ${a.agent} ${ws.join(' ')}`, c);
        } }),
      tool({ name: 'stop', description: 'Stop a sandbox without removing it.', inputSchema: { ...hostArg, sandbox: sb },
        handler: (a, c) => run(pick(a.host), `stop ${q(sandboxName(a.sandbox))}`, c) }),
      tool({ name: 'remove', description: 'Delete a sandbox and everything inside it (not its mounted workspaces). Irreversible.', annotations: { destructiveHint: true }, inputSchema: { ...hostArg, sandbox: sb },
        handler: (a, c) => run(pick(a.host), `rm --force ${q(sandboxName(a.sandbox))}`, c) }),
      tool({ name: 'exec', description: 'Run a shell command (sh -c) inside a sandbox; returns stdout+stderr. Non-interactive: no TTY, no stdin.',
        inputSchema: { ...hostArg, sandbox: sb, command: z.string(), user: z.string().regex(/^[\w.-]+(:[\w.-]+)?$/).optional().describe('e.g. root'), workdir: z.string().optional() },
        handler: (a, c) => run(pick(a.host), `exec ${a.user ? `-u ${q(a.user)} ` : ''}${a.workdir ? `-w ${q(a.workdir)} ` : ''}${q(sandboxName(a.sandbox))} sh -c ${q(a.command)}`, c) }),
      tool({ name: 'read_file', description: 'Read a text file inside a sandbox.', annotations: ro, inputSchema: { ...hostArg, sandbox: sb, path: z.string() },
        handler: (a, c) => run(pick(a.host), `exec ${q(sandboxName(a.sandbox))} cat -- ${q(a.path)}`, c) }),
      tool({ name: 'write_file', description: `Write (replace) a file inside a sandbox, creating parent directories. Up to ${MAX_WRITE} bytes; for larger files use copy from a workspace root.`,
        inputSchema: { ...hostArg, sandbox: sb, path: z.string(), content: z.string() },
        handler: (a, c) => {
          const b64 = Buffer.from(a.content, 'utf8').toString('base64');
          if (b64.length > MAX_WRITE * 4 / 3 + 4) throw new Error(`content too large for write_file (max ${MAX_WRITE} bytes); use copy`);
          return run(pick(a.host), `exec -i ${q(sandboxName(a.sandbox))} sh -c ${q('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"')} sh ${q(a.path)}`, c, b64);
        } }),
      tool({ name: 'copy', description: 'Copy a file or directory between the sandbox host and a sandbox. Exactly one of from/to is "sandbox:/path"; the other is a host path inside a workspace root (see hosts).',
        inputSchema: { ...hostArg, from: z.string(), to: z.string() },
        handler: (a, c) => {
          const h = pick(a.host);
          const side = (s: string) => { const m = /^([^/:]+):(\/.*)$/.exec(s); return m ? `${sandboxName(m[1])}:${m[2]}` : null; };
          const f = side(a.from), t = side(a.to);
          if (!!f === !!t) throw new Error('exactly one of from/to must be sandbox:/path');
          return run(h, `cp ${q(f ?? hostPath(h, a.from))} ${q(t ?? hostPath(h, a.to))}`, c);
        } }),
      tool({ name: 'ports', description: 'List a sandbox\'s published ports, or publish/unpublish: [[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL].',
        inputSchema: { ...hostArg, sandbox: sb, publish: z.array(z.string()).default([]), unpublish: z.array(z.string()).default([]) },
        handler: (a, c) => run(pick(a.host), `ports ${q(sandboxName(a.sandbox))} --json ${[...a.publish.map((p: string) => `--publish ${q(p)}`), ...a.unpublish.map((p: string) => `--unpublish ${q(p)}`)].join(' ')}`, c) }),
      tool({ name: 'policy', description: 'List policy rules (network, filesystem) as JSON: all, or those that apply to one sandbox. Rule ids are used by network_remove.', annotations: ro,
        inputSchema: { ...hostArg, sandbox: sb.optional(), type: z.enum(['all', 'network', 'http', 'filesystem']).default('all') },
        handler: (a, c) => run(pick(a.host), `policy ls ${a.sandbox ? q(sandboxName(a.sandbox)) + ' ' : ''}--wide --type ${a.type} --json`, c) }),
      tool({ name: 'network_log', description: 'Allowed and blocked outbound connections (host, count, first/last seen, blocking rule) as JSON.', annotations: ro,
        inputSchema: { ...hostArg, sandbox: sb.optional(), limit: z.number().int().min(1).max(1000).default(100) },
        handler: (a, c) => run(pick(a.host), `policy log ${a.sandbox ? q(sandboxName(a.sandbox)) + ' ' : ''}--type network --limit ${a.limit} --json`, c) }),
      tool({ name: 'network_check', description: 'Would the policy allow this host[:port] or URL (globally, or for one sandbox)?', annotations: ro,
        inputSchema: { ...hostArg, target: z.string(), sandbox: sb.optional() },
        handler: (a, c) => run(pick(a.host), `policy check network ${a.sandbox ? `--sandbox ${q(sandboxName(a.sandbox))} ` : ''}--json ${q(a.target)}`, c, undefined, [0, 1]) }), // exit 1 = denied, still an answer
      ...(['allow', 'deny'] as const).map((d) => tool({ name: `network_${d}`,
        description: `Add a network ${d} rule for hosts (comma-separated; e.g. "*.example.com") for one sandbox, or for all sandboxes when sandbox is omitted. Optional HTTP method/path restriction.`,
        inputSchema: { ...hostArg, resources: z.string(), sandbox: sb.optional(), protocol: z.enum(['tcp', 'udp', 'tcp,udp']).optional(), method: z.string().regex(/^[A-Z,]+$/).optional(), path: z.string().optional() },
        handler: (a, c) => run(pick(a.host), `policy ${d} network ${a.sandbox ? `--sandbox ${q(sandboxName(a.sandbox))} ` : ''}${a.protocol ? `--protocol ${a.protocol} ` : ''}${a.method ? `--method ${a.method} ` : ''}${a.path ? `--path ${q(a.path)} ` : ''}${q(a.resources)}`, c) })),
      tool({ name: 'network_remove', description: 'Remove a network rule by id (from policy) or by resource (and the sandbox it was scoped to).',
        inputSchema: { ...hostArg, id: z.string().optional(), resource: z.string().optional(), sandbox: sb.optional() },
        handler: (a, c) => {
          if (!!a.id === !!a.resource) throw new Error('give exactly one of id or resource');
          return run(pick(a.host), `policy rm network --force ${a.sandbox ? `--sandbox ${q(sandboxName(a.sandbox))} ` : ''}${a.id ? `--id ${q(a.id)}` : `--resource ${q(a.resource)}`}`, c);
        } }),
    ];
    return tools;
}

export default plugin;
