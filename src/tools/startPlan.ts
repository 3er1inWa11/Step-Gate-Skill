import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flattenPlan } from '../core/plan.js';
import { generateStepKey, randomCode } from '../core/keys.js';
import { createSession, type SessionInfo } from '../core/session.js';
import { createTask } from '../storage/repository.js';
import { GateErrorCode } from '../core/errors.js';
import type { PlanNode, TaskRow, StepRow } from '../types/index.js';

// One session per MCP process. Created lazily on first gate_start_plan call.
let processSession: SessionInfo | null = null;

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
    'Create a task plan with nested steps and DAG dependencies. Creates a session on first call. Returns session credentials for CLI resume.',
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

      // 2. Ensure session exists (created lazily on first call)
      if (!processSession) {
        processSession = createSession(process.cwd());
      }
      const sessionId = processSession.sessionId;

      // 3. Generate task_id (6-char alphanumeric)
      const taskId = `tsk_${randomCode(6)}`;

      // 4. Flatten nested plan into leaf steps (with DAG dependsOn)
      const leafSteps = flattenPlan(params.steps as PlanNode[], taskId);

      // 5. Determine initial current steps: those with empty dependsOn
      const initialCurrent = leafSteps.filter(s => s.dependsOn.length === 0);
      const stepKeys: Record<string, string> = {};

      // 6. Build TaskRow
      const now = new Date().toISOString();
      const task: TaskRow = {
        id: taskId,
        title: params.title,
        status: 'active',
        currentIndex: 1,
        totalSteps: leafSteps.length,
        finalKeyHash: null,
        sessionId,
        createdAt: now,
        updatedAt: now,
      };

      // 7. Build StepRow[] — initial current steps get 'current', others 'pending'
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

      // 8. Write to database (atomic transaction)
      createTask(task, steps);

      // 9. Return result with session credentials (for CLI resume)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: task.id,
              status: 'active',
              session: {
                sessionId: processSession!.sessionId,
                sessionSecret: processSession!.sessionSecret,
                recoveryToken: processSession!.recoveryToken,
                cliInstanceId: processSession!.cliInstanceId,
              },
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
