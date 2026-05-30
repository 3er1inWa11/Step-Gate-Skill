import type { TaskRow, StepRow, CurrentStepInfo } from '../types/index.js';
import { GateError, GateErrorCode } from './errors.js';
import { generateStepKey, generateTaskKey, hashKey } from './keys.js';

export interface GateRepository {
  getTask(taskId: string): TaskRow | undefined;
  getCurrentSteps(taskId: string): StepRow[];
  getTaskSteps(taskId: string): StepRow[];
  getStep(stepId: string): StepRow | undefined;
  completeAndAdvance(completedStepId: string, nextStepIds: string[], nextKeyHashes: string[], taskId: string, taskKeyHash: string | null): void;
  updateTaskStatus(taskId: string, status: string): void;
  verifyTaskKey(taskId: string, keyPlaintext: string): boolean;
}

export function validateCheckpoint(
  repo: GateRepository,
  taskId: string,
  stepId: string,
  stepKey: string
): { task: TaskRow; currentStep: StepRow } {
  const task = repo.getTask(taskId);
  if (!task) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
  }

  if (task.status !== 'active') {
    throw new GateError(GateErrorCode.TASK_ALREADY_COMPLETED, `Task already completed: ${taskId}`);
  }

  const currentSteps = repo.getCurrentSteps(taskId);
  if (currentSteps.length === 0) {
    throw new GateError(GateErrorCode.INTERNAL_ERROR, 'No current step found');
  }

  const currentStep = currentSteps.find(s => s.id === stepId);
  if (!currentStep) {
    throw new GateError(
      GateErrorCode.INVALID_CURRENT_STEP,
      `Step ${stepId} is not a current step. Current steps: [${currentSteps.map(s => s.id).join(', ')}]`,
      {
        stepId: currentSteps[0].id,
        path: currentSteps[0].path,
        index: currentSteps[0].orderIndex,
        total: task.totalSteps,
      }
    );
  }

  const keyHash = hashKey(stepKey);
  if (keyHash !== currentStep.stepKeyHash) {
    throw new GateError(
      GateErrorCode.INVALID_STEP_KEY,
      `Invalid step key for step ${stepId}`,
      {
        stepId: currentStep.id,
        path: currentStep.path,
        index: currentStep.orderIndex,
        total: task.totalSteps,
      }
    );
  }

  return { task, currentStep };
}

export function advanceSteps(
  repo: GateRepository,
  task: TaskRow,
  completedStepId: string,
): {
  nextSteps?: CurrentStepInfo[];
  nextStepKeys?: Record<string, string>;
  allStepsCompleted?: boolean;
  taskKey?: string;
} {
  const allSteps = repo.getTaskSteps(task.id);

  // 1. Find all pending steps whose dependencies are all satisfied.
  //    Treat completedStepId as already completed since it's about to be in the transaction.
  const unlockedSteps = allSteps.filter(s => {
    if (s.status !== 'pending') return false;
    return s.dependsOn.every(depId => {
      const dep = allSteps.find(x => x.id === depId);
      if (!dep) return false;
      return dep.status === 'completed' || dep.status === 'skipped' || dep.id === completedStepId;
    });
  });

  if (unlockedSteps.length > 0) {
    // Generate keys for newly activated steps
    const nextStepKeys: Record<string, string> = {};
    const nextKeyHashes: string[] = [];
    for (const step of unlockedSteps) {
      const { plaintext, hash } = generateStepKey();
      nextStepKeys[step.id] = plaintext;
      nextKeyHashes.push(hash);
    }

    repo.completeAndAdvance(
      completedStepId,
      unlockedSteps.map(s => s.id),
      nextKeyHashes,
      task.id,
      null
    );

    return {
      nextSteps: unlockedSteps.map(s => ({
        stepId: s.id,
        path: s.path,
        index: s.orderIndex,
        total: task.totalSteps,
      })),
      nextStepKeys,
    };
  }

  // 2. No pending steps unlocked → check if everything is completed
  const allCompleted = allSteps.every(s => s.status === 'completed' || s.status === 'skipped' || s.id === completedStepId);
  if (allCompleted) {
    const { plaintext, hash } = generateTaskKey();
    repo.completeAndAdvance(completedStepId, [], [], task.id, hash);
    return { allStepsCompleted: true, taskKey: plaintext };
  }

  // 3. There are pending steps but their dependencies aren't satisfied yet.
  //    This happens when completing a parallel branch — other branches are still running.
  //    Just complete this step without activating anything new.
  repo.completeAndAdvance(completedStepId, [], [], task.id, null);
  return {};
}
