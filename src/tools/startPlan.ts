import { z } from 'zod';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flattenPlan } from '../core/plan.js';
import { generateStepKey } from '../core/keys.js';
import { createTask } from '../storage/repository.js';
import { GateErrorCode } from '../core/errors.js';
import type { PlanNode, TaskRow, StepRow } from '../types/index.js';

const stepNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    title: z.string(),
    children: z.array(stepNodeSchema).optional(),
  }),
);

export function registerStartPlan(server: McpServer): void {
  server.tool(
    'gate_start_plan',
    'Create a task plan with nested steps. Returns the first step and its key.',
    {
      title: z.string(),
      steps: z.array(stepNodeSchema),
    },
    async (params) => {
      // 1. Validate input
      if (!params.title || !params.steps || params.steps.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                accepted: false,
                error: GateErrorCode.PLAN_SCHEMA_INVALID,
                message: 'Title and at least one step are required',
              }),
            },
          ],
          isError: true,
        };
      }

      // 2. Generate task_id
      const taskId = `task_${crypto.randomUUID()}`;

      // 3. Flatten nested plan into leaf steps
      const leafSteps = flattenPlan(params.steps as PlanNode[], taskId);

      // 4. Build TaskRow
      const now = new Date().toISOString();
      const task: TaskRow = {
        id: taskId,
        title: params.title,
        status: 'active',
        currentIndex: 1,
        totalSteps: leafSteps.length,
        finalKeyHash: null,
        createdAt: now,
        updatedAt: now,
      };

      // 5. Build StepRow[] (first step is 'current', rest are 'pending')
      const steps: StepRow[] = leafSteps.map((ls, i) => ({
        id: ls.id,
        taskId: ls.taskId,
        parentPath: ls.parentPath,
        title: ls.title,
        path: ls.path,
        orderIndex: ls.orderIndex,
        status: i === 0 ? 'current' : 'pending',
        stepKeyHash: null as string | null,
        completedAt: null,
        createdAt: ls.createdAt,
      }));

      // 6. Generate first step's key
      const { plaintext, hash } = generateStepKey();
      steps[0].stepKeyHash = hash;

      // 7. Write to database (atomic transaction)
      createTask(task, steps);

      // 8. Return result
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: task.id,
              status: 'active',
              currentStep: {
                stepId: steps[0].id,
                path: steps[0].path,
                index: 1,
                total: leafSteps.length,
              },
              stepKey: plaintext,
            }),
          },
        ],
      };
    },
  );
}
