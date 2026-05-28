// ============================================================================
// Agent Step Gate — gate_current MCP Tool
// Phase 1 MVP: Query the current step that should be executed.
// Does NOT return step_key — keys are only revealed once on creation.
// ============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GateCurrentInput, GateCurrentOutput } from '../types/index.js';
import { getTask, getCurrentStep } from '../storage/repository.js';

// ---------------------------------------------------------------------------
// Zod schema for input validation
// ---------------------------------------------------------------------------

const GateCurrentSchema = {
  taskId: z.string().describe('The task ID to query'),
};

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleCurrent(params: GateCurrentInput): Promise<GateCurrentOutput> {
  // 1. Get task
  const task = getTask(params.taskId);
  if (!task) {
    return {
      taskId: params.taskId,
      status: 'not_found',
      currentStep: null,
    };
  }

  // 2. Get current step
  const currentStep = getCurrentStep(params.taskId);

  if (!currentStep) {
    // No current step — all steps completed or task has no active step
    return {
      taskId: params.taskId,
      status: task.status,
      currentStep: null,
    };
  }

  // 3. Return current step info (do NOT return step_key — security design)
  return {
    taskId: params.taskId,
    status: task.status,
    currentStep: {
      stepId: currentStep.id,
      path: currentStep.path,
      index: currentStep.orderIndex,
      total: task.totalSteps,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP Tool registration
// ---------------------------------------------------------------------------

export function registerCurrent(server: McpServer): void {
  server.tool(
    'gate_current',
    "Query the current step that should be executed. Does NOT return step_key for security. Keys are only revealed on first creation (gate_start_plan) or rotation (gate_checkpoint).",
    GateCurrentSchema,
    async (args) => {
      const result = await handleCurrent(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );
}
