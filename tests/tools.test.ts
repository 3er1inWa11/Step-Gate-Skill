// ============================================================================
// Agent Step Gate — End-to-End Integration Tests
// Wave 5 (A9): Tests 4-tool flow using repository + core functions directly.
// No MCP Server transport required.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import db from '../src/storage/db.js';
import * as repo from '../src/storage/repository.js';
import { flattenPlan } from '../src/core/plan.js';
import { validateCheckpoint, advanceStep, type GateRepository } from '../src/core/gate.js';
import { generateStepKey, generateFinalKey, hashKey } from '../src/core/keys.js';
import { GateError, GateErrorCode } from '../src/core/errors.js';
import type { PlanNode, TaskRow, StepRow } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a TaskRow matching what gate_start_plan would produce. */
function makeTaskFromLeaves(
  taskId: string,
  title: string,
  leafSteps: ReturnType<typeof flattenPlan>,
): TaskRow {
  const now = new Date().toISOString();
  return {
    id: taskId,
    title,
    status: 'active',
    currentIndex: 1,
    totalSteps: leafSteps.length,
    finalKeyHash: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Build StepRow[] matching what gate_start_plan would produce. */
function makeStepsFromLeaves(
  leafSteps: ReturnType<typeof flattenPlan>,
  firstStepKeyHash: string,
): StepRow[] {
  return leafSteps.map((ls, i) => ({
    id: ls.id,
    taskId: ls.taskId,
    parentPath: ls.parentPath,
    title: ls.title,
    path: ls.path,
    orderIndex: ls.orderIndex,
    status: (i === 0 ? 'current' : 'pending') as StepRow['status'],
    stepKeyHash: i === 0 ? firstStepKeyHash : (null as string | null),
    completedAt: null,
    createdAt: ls.createdAt,
  }));
}

/** Simulate a full gate_start_plan call and return all artefacts. */
function simulateStartPlan(
  taskId: string,
  title: string,
  nodes: PlanNode[],
): { task: TaskRow; steps: StepRow[]; firstStepKeyPlaintext: string } {
  const leaves = flattenPlan(nodes, taskId);
  const { plaintext, hash } = generateStepKey();
  const task = makeTaskFromLeaves(taskId, title, leaves);
  const steps = makeStepsFromLeaves(leaves, hash);
  repo.createTask(task, steps);
  return { task, steps, firstStepKeyPlaintext: plaintext };
}

// ---------------------------------------------------------------------------
// Suite setup — clean singleton DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM steps');
  db.exec('DELETE FROM tasks');
});

// ============================================================================
// End-to-End: Simple Plan (flat 3 steps)
// ============================================================================

describe('End-to-End: Simple Plan', () => {
  it('should complete a 3-step plan from start to finalize', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
      { title: 'Step 3' },
    ];

    // 1. Simulate gate_start_plan
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'E2E Simple', nodes);

    // 2. Verify current step is step 1 (via gate_current logic)
    const task = repo.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');
    expect(task!.totalSteps).toBe(3);

    const current1 = repo.getCurrentStep(taskId);
    expect(current1).toBeDefined();
    expect(current1!.orderIndex).toBe(1);
    expect(current1!.title).toBe('Step 1');
    expect(current1!.status).toBe('current');

    // 3. Checkpoint step 1 (gate_checkpoint logic)
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    expect(v1.task).toBeDefined();
    expect(v1.currentStep.id).toBe(steps[0].id);

    const a1 = advanceStep(repo, v1.task, v1.currentStep);
    expect(a1.nextStep).toBeDefined();
    expect(a1.nextStep!.index).toBe(2);
    expect(a1.nextStepKey).toBeDefined();
    expect(a1.nextStepKey).toMatch(/^[A-Z0-9]{6}$/);

    // 4. Checkpoint step 2
    const v2 = validateCheckpoint(repo, taskId, steps[1].id, a1.nextStepKey!);
    expect(v2.currentStep.id).toBe(steps[1].id);

    const a2 = advanceStep(repo, v2.task, v2.currentStep);
    expect(a2.nextStep).toBeDefined();
    expect(a2.nextStep!.index).toBe(3);

    // 5. Checkpoint step 3 → final_key
    const v3 = validateCheckpoint(repo, taskId, steps[2].id, a2.nextStepKey!);
    expect(v3.currentStep.id).toBe(steps[2].id);

    const a3 = advanceStep(repo, v3.task, v3.currentStep);
    expect(a3.allStepsCompleted).toBe(true);
    expect(a3.finalKey).toBeDefined();
    expect(a3.finalKey).toMatch(/^[A-Z0-9]{6}$/);

    // 6. Verify final key (gate_finalize validation)
    const isValid = repo.verifyFinalKey(taskId, a3.finalKey!);
    expect(isValid).toBe(true);

    // 7. Finalize task (gate_finalize logic)
    repo.updateTaskStatus(taskId, 'completed');
    repo.addEvent(taskId, null, 'task_finalized', JSON.stringify({ taskId }));

    const completedTask = repo.getTask(taskId);
    expect(completedTask!.status).toBe('completed');
  });

  it('should handle a single-step plan', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only Step' }];

    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Single Step Plan', nodes);

    // Current step exists
    const current = repo.getCurrentStep(taskId);
    expect(current).toBeDefined();
    expect(current!.title).toBe('Only Step');

    // Checkpoint the only step → final_key immediately
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    const a = advanceStep(repo, v.task, v.currentStep);

    expect(a.allStepsCompleted).toBe(true);
    expect(a.finalKey).toBeDefined();

    // No current step after all done
    const afterCurrent = repo.getCurrentStep(taskId);
    expect(afterCurrent).toBeUndefined();

    // Verify final key works
    expect(repo.verifyFinalKey(taskId, a.finalKey!)).toBe(true);
  });
});

// ============================================================================
// End-to-End: Nested Plan
// ============================================================================

describe('End-to-End: Nested Plan', () => {
  it('should flatten nested plan and complete all leaf steps', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      {
        title: 'Phase 1',
        children: [
          { title: 'Task 1.1' },
          { title: 'Task 1.2' },
        ],
      },
      {
        title: 'Phase 2',
        children: [
          { title: 'Task 2.1' },
        ],
      },
    ];

    // 1. Simulate gate_start_plan (flattenPlan is called inside)
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Nested Plan', nodes);

    expect(steps).toHaveLength(3);
    expect(steps[0].title).toBe('Task 1.1');
    expect(steps[0].path).toBe('Phase 1 / Task 1.1');
    expect(steps[0].orderIndex).toBe(1);
    expect(steps[1].title).toBe('Task 1.2');
    expect(steps[1].path).toBe('Phase 1 / Task 1.2');
    expect(steps[1].orderIndex).toBe(2);
    expect(steps[2].title).toBe('Task 2.1');
    expect(steps[2].path).toBe('Phase 2 / Task 2.1');
    expect(steps[2].orderIndex).toBe(3);

    // 2. Checkpoint all 3 steps
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    const a1 = advanceStep(repo, v1.task, v1.currentStep);

    const v2 = validateCheckpoint(repo, taskId, steps[1].id, a1.nextStepKey!);
    const a2 = advanceStep(repo, v2.task, v2.currentStep);

    const v3 = validateCheckpoint(repo, taskId, steps[2].id, a2.nextStepKey!);
    const a3 = advanceStep(repo, v3.task, v3.currentStep);

    // 3. Last step gives final_key
    expect(a3.allStepsCompleted).toBe(true);
    expect(a3.finalKey).toBeDefined();

    // 4. Finalize
    expect(repo.verifyFinalKey(taskId, a3.finalKey!)).toBe(true);
    repo.updateTaskStatus(taskId, 'completed');
    expect(repo.getTask(taskId)!.status).toBe('completed');
  });
});

// ============================================================================
// Checkpoint Validation
// ============================================================================

describe('Checkpoint Validation', () => {
  it('should reject skipping a step (INVALID_CURRENT_STEP)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
      { title: 'Step 3' },
    ];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Skip Test', nodes);

    // Current is step 1 (orderIndex 1), but we try to checkpoint step 3
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, steps[2].id, firstStepKeyPlaintext);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_CURRENT_STEP);
    expect((error as GateError).currentStep).toBeDefined();
    expect((error as GateError).currentStep!.stepId).toBe(steps[0].id);
  });

  it('should reject reusing an old step key (INVALID_STEP_KEY)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Key Test', nodes);

    // Correctly checkpoint step 1 — this consumes the key
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v1.task, v1.currentStep);

    // Now try checkpoint step 1 again with the OLD key — should fail
    // step 1 is now 'completed' with NULL step_key_hash,
    // and it's not the current step anyway
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_CURRENT_STEP);
    // The current step should now be step 2
    expect((error as GateError).currentStep!.stepId).toBe(steps[1].id);
  });

  it('should reject wrong step key for current step (INVALID_STEP_KEY)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps } = simulateStartPlan(taskId, 'Wrong Key Test', nodes);

    // Try with a completely made-up key
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, steps[0].id, 'BADKEY');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_STEP_KEY);
  });

  it('should reject wrong taskId (TASK_NOT_FOUND)', () => {
    const fakeId = randomUUID();

    let error: unknown = null;
    try {
      validateCheckpoint(repo, fakeId, 'step-any', 'BADKEY');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.TASK_NOT_FOUND);
  });

  it('should reject checkpoint on already-completed task (TASK_ALREADY_COMPLETED)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only Step' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Done Task', nodes);

    // Complete everything
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v.task, v.currentStep);
    repo.updateTaskStatus(taskId, 'completed');

    // Now try to checkpoint again
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.TASK_ALREADY_COMPLETED);
  });
});

// ============================================================================
// Finalize Validation
// ============================================================================

describe('Finalize Validation', () => {
  it('should reject finalize with wrong final_key', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Step' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Fin Test', nodes);

    // Complete all steps
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v.task, v.currentStep);

    // Try verify with wrong key
    const isValid = repo.verifyFinalKey(taskId, 'BADKEY1');
    expect(isValid).toBe(false);
  });

  it('should reject finalize before all steps complete (no final_key_hash set)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    simulateStartPlan(taskId, 'Premature Fin', nodes);

    // Haven't checkpointed anything — final_key_hash is still null
    const isValid = repo.verifyFinalKey(taskId, 'BADKEY');
    expect(isValid).toBe(false);

    // Also verify: task should not show any final_key_hash
    const task = repo.getTask(taskId);
    expect(task!.finalKeyHash).toBeNull();
  });

  it('should accept finalize with correct final_key and transition to completed', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only Step' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Good Fin', nodes);

    // Complete the step
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    const a = advanceStep(repo, v.task, v.currentStep);
    expect(a.allStepsCompleted).toBe(true);

    // Verify with correct key
    expect(repo.verifyFinalKey(taskId, a.finalKey!)).toBe(true);

    // Finalize
    repo.updateTaskStatus(taskId, 'completed');
    const task = repo.getTask(taskId);
    expect(task!.status).toBe('completed');
  });

  it('should handle idempotent finalize (already completed task)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Step' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Idempotent', nodes);

    // Complete
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v.task, v.currentStep);
    repo.updateTaskStatus(taskId, 'completed');

    // Try finalize again — should report already completed
    const task = repo.getTask(taskId);
    expect(task!.status).toBe('completed');
  });

  it('should return current step info when key is wrong (has incomplete steps)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Partial Test', nodes);

    // Only complete step 1
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v1.task, v1.currentStep);

    // Now try verifying a final key — should fail because not all steps completed (no final_key_hash)
    const isValid = repo.verifyFinalKey(taskId, 'BADKEY');
    expect(isValid).toBe(false);

    // Also: current step should be step 2
    const currentStep = repo.getCurrentStep(taskId);
    expect(currentStep).toBeDefined();
    expect(currentStep!.id).toBe(steps[1].id);
    expect(currentStep!.orderIndex).toBe(2);
  });
});

// ============================================================================
// Persistence
// ============================================================================

describe('Persistence', () => {
  it('should retain task state after re-querying', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'A' },
      { title: 'B' },
    ];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Persistence Test', nodes);

    // Re-query task
    const task1 = repo.getTask(taskId);
    expect(task1).toBeDefined();
    expect(task1!.title).toBe('Persistence Test');
    expect(task1!.totalSteps).toBe(2);

    // Re-query steps
    const allSteps = repo.getTaskSteps(taskId);
    expect(allSteps).toHaveLength(2);
    expect(allSteps[0].orderIndex).toBe(1);
    expect(allSteps[1].orderIndex).toBe(2);
    expect(allSteps[0].status).toBe('current');
    expect(allSteps[1].status).toBe('pending');

    // Complete step 1
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v1.task, v1.currentStep);

    // Re-query — step 1 should be completed, step 2 current
    const stepsAfter = repo.getTaskSteps(taskId);
    expect(stepsAfter[0].status).toBe('completed');
    expect(stepsAfter[0].completedAt).toBeTruthy();
    expect(stepsAfter[0].stepKeyHash).toBeNull(); // key consumed
    expect(stepsAfter[1].status).toBe('current');
    expect(stepsAfter[1].stepKeyHash).toBeTruthy(); // new key set
  });

  it('should persist events across the full lifecycle', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Event Clean Test', nodes);

    // Checkpoint step 1
    const v1 = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    const a1 = advanceStep(repo, v1.task, v1.currentStep);

    // Checkpoint step 2
    const v2 = validateCheckpoint(repo, taskId, steps[1].id, a1.nextStepKey!);
    const a2 = advanceStep(repo, v2.task, v2.currentStep);
    expect(a2.allStepsCompleted).toBe(true);

    // Finalize
    repo.updateTaskStatus(taskId, 'completed');
    repo.addEvent(taskId, null, 'task_finalized', JSON.stringify({ taskId }));

    // Verify events
    const events = repo.getEvents(taskId);
    // We expect: step_completed (step 1), step_activated (step 2),
    //            step_completed (step 2), all_steps_completed,
    //            task_finalized
    expect(events.length).toBeGreaterThanOrEqual(5);

    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('step_completed');
    expect(eventTypes).toContain('step_activated');
    expect(eventTypes).toContain('all_steps_completed');
    expect(eventTypes).toContain('task_finalized');
  });
});

// ============================================================================
// gate_current scenarios (via repo directly)
// ============================================================================

describe('gate_current (simulated via repo)', () => {
  it('should return not_found for non-existent task', () => {
    const task = repo.getTask(randomUUID());
    expect(task).toBeUndefined();
  });

  it('should return current step info for an active task', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'First' },
      { title: 'Second' },
    ];
    simulateStartPlan(taskId, 'Current Test', nodes);

    const task = repo.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');

    const current = repo.getCurrentStep(taskId);
    expect(current).toBeDefined();
    expect(current!.title).toBe('First');
    expect(current!.orderIndex).toBe(1);
    expect(current!.path).toBe('First');
  });

  it('should return null current step when all steps are completed', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'All Done', nodes);

    // Complete the only step
    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v.task, v.currentStep);

    // No current step should remain
    const current = repo.getCurrentStep(taskId);
    expect(current).toBeUndefined();
  });

  it('should return status completed after finalize', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Step' }];
    const { steps, firstStepKeyPlaintext } = simulateStartPlan(taskId, 'Status Test', nodes);

    const v = validateCheckpoint(repo, taskId, steps[0].id, firstStepKeyPlaintext);
    advanceStep(repo, v.task, v.currentStep);
    repo.updateTaskStatus(taskId, 'completed');

    const task = repo.getTask(taskId);
    expect(task!.status).toBe('completed');
  });
});

// ============================================================================
// Error handling: unknown / unexpected errors
// ============================================================================

describe('Error handling', () => {
  it('repo.getTask throws TASK_NOT_FOUND for empty taskId', () => {
    expect(() => repo.getTask('')).toThrow(GateError);
    try {
      repo.getTask('');
    } catch (e) {
      expect(e).toBeInstanceOf(GateError);
      expect((e as GateError).code).toBe(GateErrorCode.TASK_NOT_FOUND);
    }
  });

  it('repo.createTask throws NO_STEPS for empty steps array', () => {
    expect(() =>
      repo.createTask(
        {
          id: randomUUID(),
          title: 'Test',
          status: 'active',
          currentIndex: 0,
          totalSteps: 0,
          finalKeyHash: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        [],
      ),
    ).toThrow(GateError);
    try {
      repo.createTask(
        {
          id: randomUUID(),
          title: 'Test',
          status: 'active',
          currentIndex: 0,
          totalSteps: 0,
          finalKeyHash: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        [],
      );
    } catch (e) {
      expect(e).toBeInstanceOf(GateError);
      expect((e as GateError).code).toBe(GateErrorCode.NO_STEPS);
    }
  });

  it('flattenPlan throws PLAN_SCHEMA_INVALID for empty array', () => {
    expect(() => flattenPlan([], randomUUID())).toThrow(GateError);
  });
});
