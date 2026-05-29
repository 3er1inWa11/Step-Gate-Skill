import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTask, cancelTask, addEvent } from '../storage/repository.js';

export function registerCancelTask(server: McpServer): void {
  server.tool(
    'gate_cancel_task',
    'Cancel an active task. All its steps will be left in their current state.',
    { taskId: z.string() },
    async (params) => {
      const task = getTask(params.taskId);
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, message: 'Task not found.' }) }],
          isError: true,
        };
      }
      if (task.status !== 'active') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, message: 'Task is not active.' }) }],
          isError: true,
        };
      }

      cancelTask(params.taskId);
      addEvent(params.taskId, null, 'task_cancelled');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ accepted: true, message: 'Task cancelled.' }) }],
      };
    },
  );
}
