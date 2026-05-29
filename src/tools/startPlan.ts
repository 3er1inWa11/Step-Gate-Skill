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
    id: z.string().optional(),
    title: z.string(),
    children: z.array(stepNodeSchema).optional(),
    dependsOn: z.array(z.string()).optional(),
  }),
);

export function registerStartPlan(server: McpServer): void {
  server.tool(
    'gate_start_plan',
    'Create a task plan with nested steps and DAG dependencies. Returns all initial current steps and their keys.',
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

      // 3. Flatten nested plan into leaf steps (with DAG dependsOn)
      const leafSteps = flattenPlan(params.steps as PlanNode[], taskId);

      // 4. Determine initial current steps: those with empty dependsOn
      const initialCurrent = leafSteps.filter(s => s.dependsOn.length === 0);
      const stepKeys: Record<string, string> = {};

      // 5. Build TaskRow
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

      // 6. Build StepRow[] — initial current steps get 'current', others 'pending'
      const steps: StepRow[] = leafSteps.map((ls) => {
        const isInitialCurrent = initialCurrent.some(cs => cs.id === ls.id);
        if (isInitialCurrent) {
          const { plaintext, hash } = generateStepKey();
          stepKeys[ls.id] = plaintext;
          return {
            id: ls.id,
            taskId: ls.taskId,
            parentPath: ls.parentPath,
            title: ls.title,
            path: ls.path,
            orderIndex: ls.orderIndex,
            dependsOn: ls.dependsOn,
            status: 'current',
            stepKeyHash: hash,
            completedAt: null,
            createdAt: ls.createdAt,
          };
        }
        return {
          id: ls.id,
          taskId: ls.taskId,
          parentPath: ls.parentPath,
          title: ls.title,
          path: ls.path,
          orderIndex: ls.orderIndex,
          dependsOn: ls.dependsOn,
          status: 'pending',
          stepKeyHash: null,
          completedAt: null,
          createdAt: ls.createdAt,
        };
      });

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
              currentSteps: initialCurrent.map(s => ({
                stepId: s.id,
                path: s.path,
                index: s.orderIndex,
                total: leafSteps.length,
              })),
              stepKeys: stepKeys,
            }),
          },
        ],
      };
    },
  );
}
