import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-test-'));

test('ssh command rules: parse, decide, enforce live on a native host, and log', async () => {
  const { programs, verdict, normalize, parse } = await import('../src/plugins/ssh/rules.js');
  const ssh = (await import('../src/plugins/ssh/index.js')).default;
  const { ScopedLogger } = await import('../src/core/logger.js');

  // parsing: every command anywhere in the line, through wrappers and nested shells
  assert.deepEqual(programs(`cd /x && ls -la | grep "a;b" ; echo 'q $(rm)' $(whoami) \`id\``), ['cd', 'ls', 'grep', 'echo', 'whoami', 'id']);
  assert.deepEqual(programs('FOO=1 sudo -u root /bin/rm -rf x; timeout 5 nice curl y'), ['sudo', 'rm', 'timeout', 'nice', 'curl']);
  assert.deepEqual(programs('ls 2>&1 | grep x'), ['ls', 'grep'], '2>&1 is a redirect, not a separator');
  assert.deepEqual(programs('bash -c "cd / && rm -rf x"'), ['bash', 'cd', 'rm']);
  assert.deepEqual(programs('ssh -p 22 box "systemctl restart nginx; rm x"'), ['ssh', 'systemctl', 'rm']);
  assert.deepEqual(programs('find . -name a -exec rm {} \\; -print'), ['find', 'rm']);
  assert.deepEqual(programs('if true; then (xargs -I{} rm {}); fi'), ['true', 'xargs', 'rm']);
  assert.deepEqual(parse('echo hi > /etc/passwd 2>/dev/null; cat < in >> "out dir/f"').writes, ['/etc/passwd', 'out dir/f']);
  assert.deepEqual(parse('X=rm; $X file').unknown, ['program name is computed: $X']);
  assert.match(parse('bash -c "rm $F"').unknown[0]!, /bash script uses variables/);
  assert.match(parse('cat <<EOF | sh\nrm x\nEOF').unknown[0]!, /sh reads commands from its input/);
  assert.match(parse('ls (').unknown[0]!, /syntax error/);
  assert.throws(() => normalize('program', '/bin/rm'));
  assert.throws(() => normalize('regex', '('));

  const L = [
    { action: 'block' as const, kind: 'program' as const, value: 'rm', host: '' },
    { action: 'block' as const, kind: 'write' as const, value: '/etc', host: '' },
    { action: 'allow' as const, kind: 'program' as const, value: 'ls', host: '' },
    { action: 'allow' as const, kind: 'program' as const, value: 'bash', host: '' },
    { action: 'allow' as const, kind: 'program' as const, value: 'echo', host: '' },
    { action: 'allow' as const, kind: 'write' as const, value: '/tmp', host: '' },
    { action: 'allow' as const, kind: 'prefix' as const, value: 'git status', host: 'dev' },
  ];
  assert.equal(verdict('sudo rm -rf /', 'h', L, 'allow').blocked, 'program: rm', 'wrapped program is seen');
  assert.equal(verdict('bash -c "ls; rm x"', 'h', L, 'allow').blocked, 'program: rm', 'inside bash -c');
  assert.equal(verdict('ls; rm x', 'h', L, 'deny').blocked, 'program: rm', 'block beats allow');
  assert.equal(verdict('ls && whoami', 'h', L, 'deny').blocked, 'default: deny', 'every command must be allowed');
  assert.equal(verdict('ls -la', 'h', L, 'deny').allowedBy, 'program: ls');
  assert.equal(verdict('bash -c "ls"', 'h', L, 'deny').allowedBy, 'program: bash, program: ls', 'allowed shell only runs allowed commands');
  assert.equal(verdict('bash -c "ls; whoami"', 'h', L, 'deny').blocked, 'default: deny');
  assert.match(verdict('bash -c "$CMD"', 'h', L, 'deny').blocked!, /^cannot check: /, 'fails closed');
  assert.equal(verdict('bash -c "$CMD"', 'h', L, 'allow').allowedBy, 'default: allow');
  assert.equal(verdict('echo x > /etc/hosts', 'h', L, 'allow').blocked, 'write: /etc');
  assert.equal(verdict('echo x > /tmp/a 2>/dev/null', 'h', L, 'deny').allowedBy, 'program: echo, write: /tmp');
  assert.equal(verdict('echo x > /tmpx', 'h', L, 'deny').blocked, 'default: deny', 'write rules match whole path components');
  assert.equal(verdict('git status -s', 'dev', L, 'deny').allowedBy, 'prefix: git status @dev');
  assert.equal(verdict('git status -s', 'prod', L, 'deny').blocked, 'default: deny', 'host-scoped rule');
  assert.equal(verdict('git statusx', 'dev', L, 'deny').blocked, 'default: deny', 'prefix matches whole words');

  const act = (k: string, p: any = {}) => (ssh.globalActions as any)[k].run(p, {} as any);
  const inst = ssh.create({ instanceId: 'i', instanceName: 'ssh', serverId: 's', global: () => ({ stateIdleSec: 60, connectionIdleSec: 60, logRetentionDays: 30 }), log: new ScopedLogger({}, () => 'off'),
    config: { ...ssh.defaultConfig, hosts: ['here'] }, pluginConfig: { hosts: [{ name: 'here', auth: 'native' }], connectTimeoutMs: 1000, keepaliveSec: 30 } } as any) as any;
  const run = (command: string) => inst.tools.find((t: any) => t.name === 'exec').handler({ host: 'here', command }, { principal: 'tok', signal: new AbortController().signal, log: new ScopedLogger({}, () => 'off') });

  const first = await run('echo hi'); assert.equal(first.isError, false, first.content[0].text);
  await act('rule', { action: 'block', kind: 'program', value: 'echo' });
  assert.match((await run('true && echo hi')).content[0].text, /blocked by administrator \(program: echo\)/, 'applies without restart');
  assert.equal((await act('deny_candidates')).programs.some(([p]: [string]) => p === 'echo'), false, 'blocked programs are not offered for allowing');
  await act('set_policy', { policy: 'deny', allow: ['true'] });
  assert.equal((await run('true')).isError, false);
  assert.match((await run('false')).content[0].text, /not on the administrator's allow list/);

  const { rows } = await act('commands', { since: 0 });
  assert.deepEqual(rows.map((r: any) => [r.command, r.exit_code, r.blocked, r.allowed_by]), [
    ['false', null, 'default: deny', null], ['true', 0, null, 'program: true'], ['true && echo hi', null, 'program: echo', null], ['echo hi', 0, null, 'default: allow']]);
  assert.equal(rows[3].now_blocked, true, 'log rows carry the current verdict');
  const pv = await act('preview', { action: 'allow', kind: 'program', value: 'echo' });
  assert.equal(pv.hits, 2); assert.equal(pv.conflicts[0].value, 'echo');

  await act('set_policy', { policy: 'allow' });
  await inst.stop();
});
