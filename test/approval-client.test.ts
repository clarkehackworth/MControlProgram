import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
process.env.MCONTROLPROGRAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
process.env.MCONTROLPROGRAM_PLUGIN_DIRS = path.resolve('examples');
const root = '../src';
const { loadPlugins } = await import(root + '/core/plugin-loader.js');
const { servers, instances, bearerTokens } = await import(root + '/core/store.js');
const { manager } = await import(root + '/mcp/manager.js');
const { setGlobalConfig } = await import(root + '/core/global-config.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

test('client channel end to end: tool rule ask → elicitation to the client → accept runs, decline refuses', async () => {
  await loadPlugins();
  const s = servers.create({ name: 'e2e', port: 47811 } as any);
  instances.create(s.id, 'echo', 'echo', {}, { mode: 'all' });
  const { token } = bearerTokens.create(s.id, 'agent');
  await manager.start(s.id);
  setGlobalConfig({ approvalChannel: 'client', approvalClientWaitSec: 10 });
  const prompts: string[] = []; let answer: 'accept' | 'decline' = 'accept';
  const client = new Client({ name: 'hermes-like', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => { prompts.push(req.params.message); return { action: answer, content: {} }; });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:47811/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try {
    const tools = await client.listTools();
    const name = tools.tools[0]!.name;
    const ok: any = await client.callTool({ name, arguments: { message: 'hi' } });
    assert.equal(ok.isError, undefined, JSON.stringify(ok)); assert.equal(prompts.length, 1); assert.match(prompts[0]!, /token:agent wants echo_say/);
    answer = 'decline';
    const no: any = await client.callTool({ name, arguments: { message: 'bye' } });
    assert.equal(no.isError, true); assert.match(no.content[0].text, /Denied/);
    setGlobalConfig({ approvalChannel: 'ui', approvalWaitSec: 1 });
    const ui: any = await client.callTool({ name, arguments: { message: 'ui' } });
    assert.equal(prompts.length, 2, 'ui channel: no client prompt'); assert.match(ui.content[0].text, /Awaiting human approval/);
  } finally { await client.close(); await manager.stop(s.id); }
});
