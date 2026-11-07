import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcontrolprogram-mcp-'));

test('mcp tool rules: per-tool rule beats default, renames carry rules, calls logged with current verdict', async () => {
  const r = await import('../src/plugins/mcp/rules.js');
  assert.deepEqual(r.verdict('gh', 'create_issue', false), { action: 'ask', by: 'default: ask' }, 'new installs ask by default');
  r.seen('gh', [{ name: 'create_issue' }, { name: 'list_issues', annotations: { readOnlyHint: true } }]);
  await r.actions.set_tool_rule.run({ upstream: 'gh', tool: 'list_issues', action: 'allow' });
  await r.actions.set_tool_rule.run({ upstream: 'gh', tool: 'create_issue', action: 'deny' });
  await r.actions.set_policy.run({ policy: 'deny' });
  assert.equal(r.verdict('gh', 'list_issues', true).action, 'allow');
  assert.equal(r.verdict('gh', 'other', false).by, 'default: deny');
  await r.actions.set_tool_rule.run({ upstream: 'gh', tool: 'create_issue', action: '' });
  assert.equal(r.verdict('gh', 'create_issue', false).by, 'default: deny', 'clearing a rule falls back to the default');
  await r.actions.set_policy.run({ policy: 'readonly' });
  assert.deepEqual(r.verdict('gh', 'ro_tool', true), { action: 'allow', by: 'default: read-only allowed' });
  assert.equal(r.verdict('gh', 'rw_tool', false).action, 'ask');
  await r.actions.set_tool_rule.run({ upstream: 'gh', tool: 'ro_tool', action: 'deny' });
  assert.equal(r.verdict('gh', 'ro_tool', true).action, 'deny', 'own rule beats readonly default');
  r.renameUpstream('gh', 'github');
  assert.equal(r.verdict('github', 'list_issues', true).action, 'allow');
  const { tools } = await r.actions.tool_rules.run();
  assert.deepEqual(tools.map((t: any) => [t.upstream, t.tool, t.rule, t.read_only]), [['github', 'create_issue', null, false], ['github', 'list_issues', 'allow', true]]);
  r.record({ upstream: 'github', tool: 'list_issues', args: { q: 1 }, allowedBy: 'tool rule: allow', ms: 3 });
  const { rows } = await r.actions.calls.run({ since: 0 });
  assert.equal(rows[0].now, 'allow');
  assert.equal(rows[0].args, '{"q":1}');
});
