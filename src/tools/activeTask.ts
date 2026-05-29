import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getActiveTask, getCurrentStep } from '../storage/repository.js';

export function registerActiveTask(server: McpServer): void {
  server.tool(
    'gate_active_task',
    'Check if there is an active Step Gate task. Returns hasActiveTask=true with taskId and currentStep if one exists. If no active task, returns hasActiveTask=false. Stop Hooks use this to determine whether to call gate_finalize.',
    {},
    async () => {
      const task = getActiveTask();

      if (!task) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ hasActiveTask: false }) }],
        };
      }

      const cs = getCurrentStep(task.id);
      const currentStepInfo = cs ? {
        stepId: cs.id,
        path: cs.path,
        index: cs.orderIndex,
        total: task.totalSteps,
      } : null;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ hasActiveTask: true, taskId: task.id, currentStep: currentStepInfo }),
        }],
      };
    },
  );
}
