import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTask, cancelTask } from '../storage/repository.js';

export function registerCancelTask(server: McpServer, getSessionId: () => string | null): void {
  server.tool(
    'gate_cancel_task',
    'Cancel an active task. All its steps will be left in their current state.',
    { taskId: z.string() },
    async (params) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, message: 'No active session. Task cancellation requires a session.' }) }],
          isError: true,
        };
      }

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

      try {
        cancelTask(params.taskId, sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accepted: true, message: 'Task cancelled.' }) }],
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, message: 'Cannot cancel task from another session.' }) }],
          isError: true,
        };
      }
    },
  );
}
