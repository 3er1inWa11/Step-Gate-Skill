// ============================================================================
// Agent Step Gate — gate_finalize MCP Tool
// Phase 1 MVP: Verifies final_key, transitions task → completed
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GateFinalizeInput, GateFinalizeOutput } from '../types/index.js';
import { getTask, getCurrentStep, verifyFinalKey, updateTaskStatus, addEvent } from '../storage/repository.js';

// ---------------------------------------------------------------------------
// Zod input schema
// ---------------------------------------------------------------------------

const FinalizeInputSchema = {
  taskId: z.string().describe('The task ID to finalize'),
  finalKey: z.string().describe('The final_key obtained from the last checkpoint'),
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleFinalize(params: GateFinalizeInput): Promise<GateFinalizeOutput> {
  // 1. Get task
  const task = getTask(params.taskId);
  if (!task) {
    return {
      accepted: false,
      status: 'not_found',
      message: 'Task not found.',
    };
  }

  // 2. Check if task is already completed (idempotent)
  if (task.status === 'completed') {
    return {
      accepted: true,
      status: 'completed',
      message: 'Task was already finalized.',
    };
  }

  // 3. Verify final_key
  const isValid = verifyFinalKey(params.taskId, params.finalKey);
  if (!isValid) {
    const currentStep = getCurrentStep(params.taskId);
    const response: GateFinalizeOutput = {
      accepted: false,
      status: 'active',
      message: 'Task cannot be finalized. Some steps are not checkpointed.',
    };
    if (currentStep) {
      response.currentStep = {
        stepId: currentStep.id,
        path: currentStep.path,
        index: currentStep.orderIndex,
        total: task.totalSteps,
      };
    }
    return response;
  }

  // 4. Validation passed — mark task completed
  updateTaskStatus(params.taskId, 'completed');
  addEvent(
    params.taskId,
    null,
    'task_finalized',
    JSON.stringify({ finalKeyHash: task.finalKeyHash }),
  );

  return {
    accepted: true,
    status: 'completed',
    message: 'All planned steps have been checkpointed.',
  };
}

// ---------------------------------------------------------------------------
// MCP Tool registration
// ---------------------------------------------------------------------------

export function registerFinalize(server: McpServer): void {
  server.tool(
    'gate_finalize',
    'Finalize a task by verifying the final_key. Stop Hooks can call this to prevent premature task completion.',
    FinalizeInputSchema,
    async (params) => {
      const output = await handleFinalize(params as GateFinalizeInput);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
        isError: !output.accepted,
      };
    },
  );
}
