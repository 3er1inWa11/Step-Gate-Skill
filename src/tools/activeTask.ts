import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getActiveTasks, getCurrentSteps, getTaskSteps } from '../storage/repository.js';

export function registerActiveTask(server: McpServer, getSessionId: () => string | null): void {
  server.tool(
    'gate_active_task',
    'List all active Step Gate tasks for the current session. Returns each task with its currentSteps. Stop Hooks use this to determine whether to call gate_finalize.',
    {},
    async () => {
      const sessionId = getSessionId();
      // Fail closed: without a session, return empty (don't leak other sessions' tasks)
      if (!sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: '', activeTasks: [] }) }],
        };
      }
      const tasks = getActiveTasks(sessionId);

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sessionId, activeTasks: [] }) }],
        };
      }

      const activeTasks = tasks.map(task => {
        const allSteps = getTaskSteps(task.id);
        const currentSteps = allSteps
          .filter(s => s.status === 'current')
          .map(s => ({
            stepId: s.id,
            path: s.path,
            index: s.orderIndex,
            total: task.totalSteps,
          }));

        return {
          taskId: task.id,
          title: task.title,
          status: task.status,
          totalSteps: task.totalSteps,
          completedSteps: allSteps.filter(s => s.status === 'completed').length,
          currentSteps,
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessionId, activeTasks }) }],
      };
    },
  );
}
