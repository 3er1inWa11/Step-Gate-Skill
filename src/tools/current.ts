// ============================================================================
// Agent Step Gate — gate_current MCP Tool
// Phase 2: Returns ALL current steps (DAG supports multiple active steps).
// ============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GateCurrentInput, GateCurrentOutput } from '../types/index.js';
import { getTask, getCurrentSteps } from '../storage/repository.js';

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
      currentSteps: [],
    };
  }

  // 2. Get all current steps
  const currentSteps = getCurrentSteps(params.taskId);

  // 3. Return current step info (do NOT return step_key — security design)
  return {
    taskId: params.taskId,
    status: task.status,
    currentSteps: currentSteps.map(cs => ({
      stepId: cs.id,
      path: cs.path,
      index: cs.orderIndex,
      total: task.totalSteps,
    })),
  };
}

// ---------------------------------------------------------------------------
// MCP Tool registration
// ---------------------------------------------------------------------------

export function registerCurrent(server: McpServer): void {
  server.tool(
    'gate_current',
    "Query all current steps for a task. Does NOT return step_keys for security. Keys are only revealed on creation (gate_start_plan) or rotation (gate_checkpoint).",
    GateCurrentSchema,
    async (args) => {
      const result = await handleCurrent(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );
}
