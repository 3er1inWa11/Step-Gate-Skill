import type { TaskRow, StepRow, CurrentStepInfo } from '../types/index.js';
import { GateError, GateErrorCode } from './errors.js';
import { generateStepKey, generateFinalKey, hashKey } from './keys.js';

export interface GateRepository {
  getTask(taskId: string): TaskRow | undefined;
  getCurrentStep(taskId: string): StepRow | undefined;
  getTaskSteps(taskId: string): StepRow[];
  completeAndAdvance(completedStepId: string, nextStepId: string | null, nextKeyHash: string | null, taskId: string, finalKeyHash: string | null): void;
  updateTaskStatus(taskId: string, status: string): void;
  verifyFinalKey(taskId: string, keyPlaintext: string): boolean;
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

  const currentStep = repo.getCurrentStep(taskId);
  if (!currentStep) {
    throw new GateError(GateErrorCode.INTERNAL_ERROR, 'No current step found');
  }

  if (currentStep.id !== stepId) {
    throw new GateError(
      GateErrorCode.INVALID_CURRENT_STEP,
      `Step ${stepId} is not the current step`,
      {
        stepId: currentStep.id,
        path: currentStep.path,
        index: currentStep.orderIndex,
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

export function advanceStep(
  repo: GateRepository,
  task: TaskRow,
  currentStep: StepRow,
): { nextStep?: CurrentStepInfo; nextStepKey?: string; allStepsCompleted?: boolean; finalKey?: string } {
  const allSteps = repo.getTaskSteps(task.id);
  const nextStep = allSteps.find((s) => s.orderIndex === currentStep.orderIndex + 1);

  if (nextStep) {
    const { plaintext, hash } = generateStepKey();
    repo.completeAndAdvance(currentStep.id, nextStep.id, hash, task.id, null);
    return {
      nextStep: {
        stepId: nextStep.id,
        path: nextStep.path,
        index: nextStep.orderIndex,
        total: task.totalSteps,
      },
      nextStepKey: plaintext,
    };
  }

  const { plaintext, hash } = generateFinalKey();
  repo.completeAndAdvance(currentStep.id, null, null, task.id, hash);
  return {
    allStepsCompleted: true,
    finalKey: plaintext,
  };
}
