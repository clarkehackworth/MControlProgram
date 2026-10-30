// Tiny upstream MCP server for tests. `node echo-mcp.mjs` = stdio; `node echo-mcp.mjs http <port> <token>` = Streamable HTTP with bearer auth.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
const mk = () => { const srv = new McpServer({ name: 'echo-upstream', version: '1.0.0' });
srv.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string().describe('What to echo') }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
srv.registerTool('write_thing', { description: 'Pretend write', inputSchema: { id: z.number() } }, async ({ id }) => ({ content: [{ type: 'text', text: `wrote ${id}` }] }));
srv.registerTool('secret_env', { description: 'Reveal env', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: process.env.UPSTREAM_SECRET ?? 'unset' }] }));
return srv; };
if (process.argv[2] === 'http') {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const express = (await import('express')).default;
  const app = express(); app.use(express.json());
  app.all('/mcp', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${process.argv[4]}`) return res.status(401).json({ error: 'unauthorized' });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => t.close());
    await mk().connect(t); await t.handleRequest(req, res, req.body);
  });
  app.listen(Number(process.argv[3]), '127.0.0.1', () => console.log('ready'));
} else {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await mk().connect(new StdioServerTransport());
}
