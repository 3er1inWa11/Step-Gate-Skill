import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerStartPlan } from './tools/startPlan.js';
import { registerCurrent } from './tools/current.js';
import { registerCheckpoint } from './tools/checkpoint.js';
import { registerFinalize } from './tools/finalize.js';
import { registerActiveTask } from './tools/activeTask.js';
import { registerCancelTask } from './tools/cancelTask.js';

const server = new McpServer({
  name: 'agent-step-gate',
  version: '0.2.0',
});

registerStartPlan(server);
registerCurrent(server);
registerCheckpoint(server);
registerFinalize(server);
registerActiveTask(server);
registerCancelTask(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
