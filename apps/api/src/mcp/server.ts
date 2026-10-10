import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** Placeholder MCP server; register real tools here. */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'driftmark', version: '0.0.0' });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health check that echoes the supplied message.',
      inputSchema: { message: z.string().describe('Text to echo back') },
    },
    async ({ message }) => ({
      content: [{ type: 'text' as const, text: `pong: ${message}` }],
    }),
  );

  return server;
}

// Run directly with `pnpm --filter @agent-config-study/api mcp`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}
