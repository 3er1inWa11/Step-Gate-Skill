// ============================================================================
// Agent Step Gate — gate_finalize MCP Tool
// Phase 2: Returns pendingSteps on failure so Agent sees what's missing.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GateFinalizeInput, GateFinalizeOutput } from '../types/index.js';
import { getTask, getCurrentSteps, getTaskSteps, verifyTaskKey, updateTaskStatus, addEvent } from '../storage/repository.js';
import { commitProgramNode } from '../core/program.js';

// ---------------------------------------------------------------------------
// Zod input schema
// ---------------------------------------------------------------------------

const FinalizeInputSchema = {
  taskId: z.string().describe('The task ID to finalize'),
  taskKey: z.string().describe('The task key obtained from the last checkpoint'),
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

  // 3. Verify task key
  const isValid = verifyTaskKey(params.taskId, params.taskKey);
  if (!isValid) {
    const allSteps = getTaskSteps(params.taskId);
    const pendingSteps = allSteps
      .filter(s => s.status !== 'completed' && s.status !== 'skipped')
      .map(s => ({
        stepId: s.id,
        path: s.path,
        index: s.orderIndex,
        total: task.totalSteps,
      }));

    const response: GateFinalizeOutput = {
      accepted: false,
      status: 'active',
      message: 'Task cannot be finalized. Some steps are not checkpointed.',
      pendingSteps,
    };
    return response;
  }

  // 4. Validation passed — mark task completed
  updateTaskStatus(params.taskId, 'completed');
  addEvent(
    params.taskId,
    null,
    'task_finalized',
    JSON.stringify({ taskKeyHash: task.finalKeyHash }),
  );

  const output: GateFinalizeOutput = {
    accepted: true,
    status: 'completed',
    message: 'All planned steps have been checkpointed.',
  };

  // 5. Auto-propagate: check if node is complete
  if (task.sessionId) {
    const cr = commitProgramNode(task.sessionId);
    if (cr) {
      (output as any).nodeCompleted = { nodeId: cr.nodeId, programId: cr.programId, nodeKey: cr.nodeKey };
      output.message = 'Task finalized. Node auto-completed (all tasks done).';
      if (cr.allDone) {
        (output as any).programCompleted = { programId: cr.programId };
        output.message = 'Task finalized → Node completed → Program completed.';
      }
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// MCP Tool registration
// ---------------------------------------------------------------------------

export function registerFinalize(server: McpServer): void {
  server.tool(
    'gate_finalize',
    'Finalize a task by verifying the final_key. Returns pendingSteps when steps are missing. Stop Hooks can call this to prevent premature task completion.',
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
