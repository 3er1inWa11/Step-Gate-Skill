// ============================================================================
// Agent Step Gate — gate_checkpoint MCP Tool
// Phase 2: Supports DAG — returns multiple next steps, stepId is required.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GateCheckpointInput, GateCheckpointOutput } from '../types/index.js';
import { GateError, GateErrorCode } from '../core/errors.js';
import { validateCheckpoint, advanceSteps } from '../core/gate.js';
import * as repo from '../storage/repository.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleCheckpoint(params: GateCheckpointInput): Promise<GateCheckpointOutput> {
  try {
    // validateCheckpoint performs 5 checks, throws GateError on failure
    const { task, currentStep } = validateCheckpoint(
      repo,
      params.taskId,
      params.stepId,
      params.stepKey,
    );

    // Advance the DAG state machine
    const result = advanceSteps(repo, task, params.stepId);

    // All steps completed → return final_key
    if (result.allStepsCompleted) {
      return {
        accepted: true,
        allStepsCompleted: true,
        finalKey: result.finalKey,
        completedStep: { stepId: currentStep.id, path: currentStep.path },
      };
    }

    // Normal advance → return next steps (may be empty if parallel branch)
    return {
      accepted: true,
      completedStep: { stepId: currentStep.id, path: currentStep.path },
      nextSteps: result.nextSteps,
      nextStepKeys: result.nextStepKeys,
    };
  } catch (err) {
    if (err instanceof GateError) {
      const response: GateCheckpointOutput = {
        accepted: false,
        error: err.code,
        message: err.message,
      };
      if (err.currentStep) {
        response.currentStep = err.currentStep;
      }
      return response;
    }
    // Unknown error
    return {
      accepted: false,
      error: GateErrorCode.INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// MCP Tool registration
// ---------------------------------------------------------------------------

export function registerCheckpoint(server: McpServer): void {
  server.tool(
    'gate_checkpoint',
    'Complete a current step and unlock next steps whose dependencies are satisfied. Returns next step keys (may be multiple for parallel branches). Returns final_key when all steps are done.',
    {
      taskId: z.string().describe('The task ID'),
      stepId: z.string().describe('The step ID being completed'),
      stepKey: z.string().describe('The step key for the current step (proves possession)'),
    },
    async (params) => {
      const output = await handleCheckpoint(params as GateCheckpointInput);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        isError: !output.accepted,
      };
    },
  );
}
