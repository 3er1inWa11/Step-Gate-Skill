// ============================================================================
// Agent Step Gate — End-to-End Integration Tests (Phase 2: DAG)
// Tests 6-tool flow using repository + core functions directly.
// No MCP Server transport required.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import db from '../src/storage/db.js';
import * as repo from '../src/storage/repository.js';
import { flattenPlan } from '../src/core/plan.js';
import { validateCheckpoint, advanceSteps, type GateRepository } from '../src/core/gate.js';
import { generateStepKey, generateFinalKey, hashKey } from '../src/core/keys.js';
import { GateError, GateErrorCode } from '../src/core/errors.js';
import type { PlanNode, TaskRow, StepRow } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeStepsFromLeaves(
  leafSteps: ReturnType<typeof flattenPlan>,
  stepKeys: Record<string, { plaintext: string; hash: string }>,
): StepRow[] {
  return leafSteps.map((ls) => {
    const initialCurrent = ls.dependsOn.length === 0;
    const keyInfo = stepKeys[ls.id];
    return {
      id: ls.id,
      taskId: ls.taskId,
      parentPath: ls.parentPath,
      title: ls.title,
      path: ls.path,
      orderIndex: ls.orderIndex,
      dependsOn: ls.dependsOn,
      status: initialCurrent ? 'current' as const : 'pending' as const,
      stepKeyHash: initialCurrent && keyInfo ? keyInfo.hash : (null as string | null),
      completedAt: null,
      createdAt: ls.createdAt,
    };
  });
}

function simulateStartPlan(
  taskId: string,
  title: string,
  nodes: PlanNode[],
): { task: TaskRow; steps: StepRow[]; stepKeys: Record<string, string>; firstStepId: string } {
  const leaves = flattenPlan(nodes, taskId);
  const initialCurrent = leaves.filter(s => s.dependsOn.length === 0);
  const stepKeyMap: Record<string, { plaintext: string; hash: string }> = {};
  const plaintextKeys: Record<string, string> = {};

  for (const s of initialCurrent) {
    const k = generateStepKey();
    stepKeyMap[s.id] = k;
    plaintextKeys[s.id] = k.plaintext;
  }

  const task = makeTaskFromLeaves(taskId, title, leaves);
  const steps = makeStepsFromLeaves(leaves, stepKeyMap);
  repo.createTask(task, steps);
  return {
    task,
    steps,
    stepKeys: plaintextKeys,
    firstStepId: initialCurrent[0]?.id ?? '',
  };
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
// End-to-End: Simple Serial Plan (auto-serial)
// ============================================================================

describe('End-to-End: Simple Serial Plan', () => {
  it('should complete a 3-step plan from start to finalize', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
      { title: 'Step 3' },
    ];

    // 1. Simulate gate_start_plan
    const { steps, stepKeys, firstStepId } = simulateStartPlan(taskId, 'E2E Simple', nodes);
    const step1Id = steps[0].id;
    const step2Id = steps[1].id;
    const step3Id = steps[2].id;

    // Verify initial state
    const task = repo.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');
    expect(task!.totalSteps).toBe(3);

    // Only first step should be current (auto-serial: first step has no deps)
    const initialCurrent = repo.getCurrentSteps(taskId);
    expect(initialCurrent).toHaveLength(1);
    expect(initialCurrent[0].id).toBe(firstStepId);
    expect(initialCurrent[0].orderIndex).toBe(1);

    // Checkpoint step 1
    const v1 = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    const a1 = advanceSteps(repo, v1.task, step1Id);
    expect(a1.nextSteps).toBeDefined();
    expect(a1.nextSteps!.length).toBe(1);
    expect(a1.nextSteps![0].stepId).toBe(step2Id);
    expect(a1.nextStepKeys).toBeDefined();
    const key2 = a1.nextStepKeys![step2Id];
    expect(key2).toMatch(/^[A-Z0-9]{6}$/);

    // Checkpoint step 2
    const v2 = validateCheckpoint(repo, taskId, step2Id, key2);
    const a2 = advanceSteps(repo, v2.task, step2Id);
    expect(a2.nextSteps!.length).toBe(1);
    expect(a2.nextSteps![0].stepId).toBe(step3Id);
    const key3 = a2.nextStepKeys![step3Id];

    // Checkpoint step 3 → final_key
    const v3 = validateCheckpoint(repo, taskId, step3Id, key3);
    const a3 = advanceSteps(repo, v3.task, step3Id);
    expect(a3.allStepsCompleted).toBe(true);
    expect(a3.finalKey).toMatch(/^[A-Z0-9]{6}$/);

    // Verify final key
    expect(repo.verifyFinalKey(taskId, a3.finalKey!)).toBe(true);

    // Finalize
    repo.updateTaskStatus(taskId, 'completed');
    repo.addEvent(taskId, null, 'task_finalized', JSON.stringify({ taskId }));
    expect(repo.getTask(taskId)!.status).toBe('completed');
  });

  it('should handle a single-step plan', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only Step' }];

    const { steps, stepKeys } = simulateStartPlan(taskId, 'Single Step Plan', nodes);
    const step1Id = steps[0].id;

    // Checkpoint the only step → final_key immediately
    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    const a = advanceSteps(repo, v.task, step1Id);

    expect(a.allStepsCompleted).toBe(true);
    expect(a.finalKey).toBeDefined();
    expect(repo.verifyFinalKey(taskId, a.finalKey!)).toBe(true);
  });
});

// ============================================================================
// End-to-End: DAG Plan (parallel branches)
// ============================================================================

describe('End-to-End: DAG Plan', () => {
  it('should handle parallel branches with merge point', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { id: 'init', title: 'Init' },
      { id: 'modA', title: 'Module A', dependsOn: ['init'] },
      { id: 'modB', title: 'Module B', dependsOn: ['init'] },
      { id: 'test', title: 'Integration Test', dependsOn: ['modA', 'modB'] },
    ];

    const { stepKeys } = simulateStartPlan(taskId, 'DAG Plan', nodes);

    // Only 'init' should be current (no deps)
    const current1 = repo.getCurrentSteps(taskId);
    expect(current1).toHaveLength(1);
    expect(current1[0].id).toBe('init');

    // Complete init → modA and modB should both unlock
    const v1 = validateCheckpoint(repo, taskId, 'init', stepKeys['init']);
    const a1 = advanceSteps(repo, v1.task, 'init');
    expect(a1.nextSteps).toBeDefined();
    expect(a1.nextSteps!.length).toBe(2);
    const modAKey = a1.nextStepKeys!['modA'];
    const modBKey = a1.nextStepKeys!['modB'];

    // Both modA and modB should be current
    const current2 = repo.getCurrentSteps(taskId);
    expect(current2).toHaveLength(2);
    expect(current2.map(s => s.id).sort()).toEqual(['modA', 'modB']);

    // Complete modA → integration test should NOT unlock yet (modB still active)
    const v2a = validateCheckpoint(repo, taskId, 'modA', modAKey);
    const a2a = advanceSteps(repo, v2a.task, 'modA');
    expect(a2a.nextSteps).toBeUndefined(); // nothing unlocks yet
    expect(a2a.allStepsCompleted).toBeUndefined();

    // Complete modB → integration test should now unlock
    const v2b = validateCheckpoint(repo, taskId, 'modB', modBKey);
    const a2b = advanceSteps(repo, v2b.task, 'modB');
    expect(a2b.nextSteps).toBeDefined();
    expect(a2b.nextSteps!.length).toBe(1);
    expect(a2b.nextSteps![0].stepId).toBe('test');
    const testKey = a2b.nextStepKeys!['test'];

    // Complete integration test → all done
    const v3 = validateCheckpoint(repo, taskId, 'test', testKey);
    const a3 = advanceSteps(repo, v3.task, 'test');
    expect(a3.allStepsCompleted).toBe(true);
    expect(a3.finalKey).toBeDefined();
    expect(repo.verifyFinalKey(taskId, a3.finalKey!)).toBe(true);
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

    const { steps, stepKeys } = simulateStartPlan(taskId, 'Nested Plan', nodes);
    const step1Id = steps[0].id;
    const step2Id = steps[1].id;
    const step3Id = steps[2].id;

    // Auto-generated ids: {taskId}_step_1, {taskId}_step_2, {taskId}_step_3 (serial)
    const current = repo.getCurrentSteps(taskId);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(step1Id);

    // Complete all 3 steps
    const v1 = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    const a1 = advanceSteps(repo, v1.task, step1Id);
    const key2 = a1.nextStepKeys![step2Id];

    const v2 = validateCheckpoint(repo, taskId, step2Id, key2);
    const a2 = advanceSteps(repo, v2.task, step2Id);
    const key3 = a2.nextStepKeys![step3Id];

    const v3 = validateCheckpoint(repo, taskId, step3Id, key3);
    const a3 = advanceSteps(repo, v3.task, step3Id);

    expect(a3.allStepsCompleted).toBe(true);
    expect(a3.finalKey).toBeDefined();
    expect(repo.verifyFinalKey(taskId, a3.finalKey!)).toBe(true);
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
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Skip Test', nodes);
    const step1Id = steps[0].id;
    const step3Id = steps[2].id;

    // Current is first step, try to checkpoint last step
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, step3Id, stepKeys[step1Id]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_CURRENT_STEP);
  });

  it('should reject reusing an old step key (INVALID_STEP_KEY)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Key Test', nodes);
    const step1Id = steps[0].id;

    // Correctly checkpoint step 1
    const v1 = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v1.task, step1Id);

    // Try checkpoint step 1 again with OLD key
    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_CURRENT_STEP);
  });

  it('should reject wrong step key for current step (INVALID_STEP_KEY)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps } = simulateStartPlan(taskId, 'Wrong Key Test', nodes);
    const step1Id = steps[0].id;

    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, step1Id, 'BADKEY');
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
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Done Task', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v.task, step1Id);
    repo.updateTaskStatus(taskId, 'completed');

    let error: unknown = null;
    try {
      validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
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
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Fin Test', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v.task, step1Id);

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

    expect(repo.verifyFinalKey(taskId, 'BADKEY')).toBe(false);
    const task = repo.getTask(taskId);
    expect(task!.finalKeyHash).toBeNull();
  });

  it('should accept finalize with correct final_key and transition to completed', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only Step' }];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Good Fin', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    const a = advanceSteps(repo, v.task, step1Id);
    expect(a.allStepsCompleted).toBe(true);

    expect(repo.verifyFinalKey(taskId, a.finalKey!)).toBe(true);
    repo.updateTaskStatus(taskId, 'completed');
    expect(repo.getTask(taskId)!.status).toBe('completed');
  });

  it('should handle idempotent finalize (already completed task)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Step' }];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Idempotent', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v.task, step1Id);
    repo.updateTaskStatus(taskId, 'completed');

    const task = repo.getTask(taskId);
    expect(task!.status).toBe('completed');
  });

  it('should show all pending steps when finalize fails (DAG)', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { id: 'init', title: 'Init' },
      { id: 'modA', title: 'Module A', dependsOn: ['init'] },
      { id: 'modB', title: 'Module B', dependsOn: ['init'] },
      { id: 'test', title: 'Test', dependsOn: ['modA', 'modB'] },
    ];
    const { stepKeys } = simulateStartPlan(taskId, 'Partial DAG', nodes);

    // Only complete init
    const v1 = validateCheckpoint(repo, taskId, 'init', stepKeys['init']);
    advanceSteps(repo, v1.task, 'init');

    // Now try verifying final key — should fail
    const isValid = repo.verifyFinalKey(taskId, 'BADKEY');
    expect(isValid).toBe(false);

    // Check pending steps
    const allSteps = repo.getTaskSteps(taskId);
    const pendingSteps = allSteps.filter(s => s.status !== 'completed');
    // init should be completed, modA/modB current, test pending
    expect(pendingSteps.length).toBe(3);
    const pendingIds = pendingSteps.map(s => s.id).sort();
    expect(pendingIds).toContain('modA');
    expect(pendingIds).toContain('modB');
    expect(pendingIds).toContain('test');
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
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Persistence Test', nodes);
    const step1Id = steps[0].id;

    const task1 = repo.getTask(taskId);
    expect(task1).toBeDefined();
    expect(task1!.title).toBe('Persistence Test');
    expect(task1!.totalSteps).toBe(2);

    const allSteps = repo.getTaskSteps(taskId);
    expect(allSteps).toHaveLength(2);
    expect(allSteps[0].status).toBe('current');
    expect(allSteps[1].status).toBe('pending');

    // Complete first step
    const v1 = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v1.task, step1Id);

    const stepsAfter = repo.getTaskSteps(taskId);
    expect(stepsAfter[0].status).toBe('completed');
    expect(stepsAfter[0].stepKeyHash).toBeNull();
    expect(stepsAfter[1].status).toBe('current');
    expect(stepsAfter[1].stepKeyHash).toBeTruthy();
  });

  it('should persist events across the full lifecycle', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { title: 'Step 1' },
      { title: 'Step 2' },
    ];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Event Clean Test', nodes);
    const step1Id = steps[0].id;
    const step2Id = steps[1].id;

    const v1 = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    const a1 = advanceSteps(repo, v1.task, step1Id);

    const v2 = validateCheckpoint(repo, taskId, step2Id, a1.nextStepKeys![step2Id]);
    const a2 = advanceSteps(repo, v2.task, step2Id);
    expect(a2.allStepsCompleted).toBe(true);

    repo.updateTaskStatus(taskId, 'completed');
    repo.addEvent(taskId, null, 'task_finalized', JSON.stringify({ taskId }));

    const events = repo.getEvents(taskId);
    expect(events.length).toBeGreaterThanOrEqual(5);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('step_completed');
    expect(eventTypes).toContain('step_activated');
    expect(eventTypes).toContain('all_steps_completed');
    expect(eventTypes).toContain('task_finalized');
  });
});

// ============================================================================
// Multi-task support
// ============================================================================

describe('Multi-task support', () => {
  it('should allow multiple simultaneous active tasks', () => {
    const taskId1 = randomUUID();
    const taskId2 = randomUUID();

    simulateStartPlan(taskId1, 'Task 1', [{ title: 'Step A' }]);
    simulateStartPlan(taskId2, 'Task 2', [{ title: 'Step B' }]);

    const activeTasks = repo.getActiveTasks();
    expect(activeTasks).toHaveLength(2);

    // Each task has its own current step
    const cs1 = repo.getCurrentSteps(taskId1);
    const cs2 = repo.getCurrentSteps(taskId2);
    expect(cs1).toHaveLength(1);
    expect(cs2).toHaveLength(1);
  });

  it('should allow cancelling a task', () => {
    const taskId = randomUUID();
    simulateStartPlan(taskId, 'Cancel Me', [{ title: 'Step 1' }]);

    repo.cancelTask(taskId);
    repo.addEvent(taskId, null, 'task_cancelled');

    const task = repo.getTask(taskId);
    expect(task!.status).toBe('cancelled');

    // Cancelled task not in active tasks
    const activeTasks = repo.getActiveTasks();
    expect(activeTasks.find(t => t.id === taskId)).toBeUndefined();
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

  it('should return all current steps for an active task', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [
      { id: 'init', title: 'Init' },
      { id: 'modA', title: 'Module A', dependsOn: ['init'] },
      { id: 'modB', title: 'Module B', dependsOn: ['init'] },
    ];
    const { stepKeys } = simulateStartPlan(taskId, 'DAG Current', nodes);

    // Only init should be current
    const current1 = repo.getCurrentSteps(taskId);
    expect(current1).toHaveLength(1);
    expect(current1[0].id).toBe('init');

    // Complete init → modA, modB both current
    const v = validateCheckpoint(repo, taskId, 'init', stepKeys['init']);
    advanceSteps(repo, v.task, 'init');

    const current2 = repo.getCurrentSteps(taskId);
    expect(current2).toHaveLength(2);
    expect(current2.map(s => s.id).sort()).toEqual(['modA', 'modB']);
  });

  it('should return empty current steps when all completed', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Only' }];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'All Done', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v.task, step1Id);

    expect(repo.getCurrentSteps(taskId)).toEqual([]);
  });

  it('should return status completed after finalize', () => {
    const taskId = randomUUID();
    const nodes: PlanNode[] = [{ title: 'Step' }];
    const { steps, stepKeys } = simulateStartPlan(taskId, 'Status Test', nodes);
    const step1Id = steps[0].id;

    const v = validateCheckpoint(repo, taskId, step1Id, stepKeys[step1Id]);
    advanceSteps(repo, v.task, step1Id);
    repo.updateTaskStatus(taskId, 'completed');

    expect(repo.getTask(taskId)!.status).toBe('completed');
  });
});

// ============================================================================
// Error handling
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
  });

  it('flattenPlan throws PLAN_SCHEMA_INVALID for empty array', () => {
    expect(() => flattenPlan([], randomUUID())).toThrow(GateError);
  });
});
