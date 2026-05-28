import { describe, it, expect, vi } from 'vitest';
import { generateStepKey, generateFinalKey, hashKey } from '../src/core/keys.js';
import { flattenPlan } from '../src/core/plan.js';
import { validateCheckpoint, advanceStep } from '../src/core/gate.js';
import { GateError, GateErrorCode } from '../src/core/errors.js';
import type { GateRepository } from '../src/core/gate.js';
import type { TaskRow, StepRow } from '../src/types/index.js';
import type { PlanNode } from '../src/types/index.js';

// ============================================================================
// keys.ts tests
// ============================================================================

describe('keys', () => {
  describe('hashKey', () => {
    it('returns a 64-character hex string', () => {
      const result = hashKey('hello world');
      expect(result).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(result)).toBe(true);
    });

    it('is deterministic — same input produces same hash', () => {
      expect(hashKey('abc')).toBe(hashKey('abc'));
    });

    it('different inputs produce different hashes', () => {
      expect(hashKey('abc')).not.toBe(hashKey('xyz'));
    });
  });

  describe('generateStepKey', () => {
    it('returns plaintext and hash', () => {
      const { plaintext, hash } = generateStepKey();
      expect(plaintext).toMatch(/^sg_step_[a-f0-9]{64}$/);
      expect(hash).toHaveLength(64);
    });

    it('hash matches plaintext', () => {
      const { plaintext, hash } = generateStepKey();
      expect(hashKey(plaintext)).toBe(hash);
    });

    it('generates unique keys across calls', () => {
      const a = generateStepKey();
      const b = generateStepKey();
      expect(a.plaintext).not.toBe(b.plaintext);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('generateFinalKey', () => {
    it('returns plaintext and hash with sg_final_ prefix', () => {
      const { plaintext, hash } = generateFinalKey();
      expect(plaintext).toMatch(/^sg_final_[a-f0-9]{64}$/);
      expect(hash).toHaveLength(64);
    });

    it('hash matches plaintext', () => {
      const { plaintext, hash } = generateFinalKey();
      expect(hashKey(plaintext)).toBe(hash);
    });

    it('generates unique keys across calls', () => {
      const a = generateFinalKey();
      const b = generateFinalKey();
      expect(a.plaintext).not.toBe(b.plaintext);
    });
  });

  it('step keys and final keys use different prefixes', () => {
    const step = generateStepKey();
    const final = generateFinalKey();
    expect(step.plaintext.startsWith('sg_step_')).toBe(true);
    expect(final.plaintext.startsWith('sg_final_')).toBe(true);
  });
});

// ============================================================================
// plan.ts tests
// ============================================================================

describe('flattenPlan', () => {
  it('flattens a nested plan into leaf steps with DFS order', () => {
    const nodes: PlanNode[] = [
      {
        title: 'Phase 1',
        children: [{ title: 'Task 1' }, { title: 'Task 2' }],
      },
      {
        title: 'Phase 2',
        children: [{ title: 'Task 3' }],
      },
    ];

    const result = flattenPlan(nodes, 'task-1');

    expect(result).toHaveLength(3);

    expect(result[0].title).toBe('Task 1');
    expect(result[0].path).toBe('Phase 1 / Task 1');
    expect(result[0].orderIndex).toBe(1);
    expect(result[0].parentPath).toBeNull();

    expect(result[1].title).toBe('Task 2');
    expect(result[1].path).toBe('Phase 1 / Task 2');
    expect(result[1].orderIndex).toBe(2);

    expect(result[2].title).toBe('Task 3');
    expect(result[2].path).toBe('Phase 2 / Task 3');
    expect(result[2].orderIndex).toBe(3);
  });

  it('handles a flat plan (no nesting)', () => {
    const nodes: PlanNode[] = [{ title: 'Step A' }, { title: 'Step B' }];

    const result = flattenPlan(nodes, 'task-2');

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Step A');
    expect(result[0].path).toBe('Step A');
    expect(result[0].orderIndex).toBe(1);
    expect(result[1].title).toBe('Step B');
    expect(result[1].path).toBe('Step B');
    expect(result[1].orderIndex).toBe(2);
  });

  it('handles deeply nested plan (3+ levels)', () => {
    const nodes: PlanNode[] = [
      {
        title: 'A',
        children: [
          {
            title: 'B',
            children: [{ title: 'C' }],
          },
        ],
      },
    ];

    const result = flattenPlan(nodes, 'task-3');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('C');
    expect(result[0].path).toBe('A / B / C');
  });

  it('treats nodes with empty children array as leaves', () => {
    const nodes: PlanNode[] = [
      { title: 'Node', children: [] },
    ];

    const result = flattenPlan(nodes, 'task-4');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Node');
    expect(result[0].path).toBe('Node');
  });

  it('prepends parentPath when provided', () => {
    const nodes: PlanNode[] = [{ title: 'Step 1' }];

    const result = flattenPlan(nodes, 'task-5', 'Project Alpha');

    expect(result[0].path).toBe('Project Alpha / Step 1');
    expect(result[0].parentPath).toBe('Project Alpha');
  });

  it('prepends parentPath with nested nodes', () => {
    const nodes: PlanNode[] = [
      {
        title: 'Phase',
        children: [{ title: 'Task' }],
      },
    ];

    const result = flattenPlan(nodes, 'task-6', 'Prefix');

    expect(result[0].path).toBe('Prefix / Phase / Task');
    expect(result[0].parentPath).toBe('Prefix');
  });

  it('sets all leaves to pending status with null completedAt', () => {
    const nodes: PlanNode[] = [{ title: 'Step' }];

    const result = flattenPlan(nodes, 'task-7');

    expect(result[0].status).toBe('pending');
    expect(result[0].completedAt).toBeNull();
  });

  describe('validation errors', () => {
    it('throws PLAN_SCHEMA_INVALID when nodes array is empty', () => {
      expect(() => flattenPlan([], 'task-8')).toThrow(GateError);
      try {
        flattenPlan([], 'task-8');
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).code).toBe(GateErrorCode.PLAN_SCHEMA_INVALID);
        expect((e as GateError).message).toBe('Plan must have at least one step');
      }
    });

    it('throws PLAN_SCHEMA_INVALID when a node has no title', () => {
      const nodes: PlanNode[] = [
        { title: 'Good' },
        { title: '' } as PlanNode, // empty string title
      ];

      expect(() => flattenPlan(nodes, 'task-9')).toThrow(GateError);
      try {
        flattenPlan(nodes, 'task-9');
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).code).toBe(GateErrorCode.PLAN_SCHEMA_INVALID);
        expect((e as GateError).message).toBe('Each step must have a title');
      }
    });

    it('throws when a nested node has no title', () => {
      const nodes: PlanNode[] = [
        {
          title: 'Phase',
          children: [{ title: '' } as PlanNode],
        },
      ];

      expect(() => flattenPlan(nodes, 'task-10')).toThrow(GateError);
    });
  });
});

// ============================================================================
// gate.ts tests — validateCheckpoint
// ============================================================================

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    title: 'Test Task',
    status: 'active',
    currentIndex: 0,
    totalSteps: 3,
    finalKeyHash: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepRow> = {}): StepRow {
  return {
    id: 'step-1',
    taskId: 'task-1',
    parentPath: null,
    title: 'First Step',
    path: 'First Step',
    orderIndex: 1,
    status: 'current',
    stepKeyHash: null,
    completedAt: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateCheckpoint', () => {
  it('returns task and currentStep on successful validation', () => {
    const stepKey = 'sg_step_aaaa';
    const keyHash = hashKey(stepKey);
    const step = makeStep({ stepKeyHash: keyHash });
    const task = makeTask();

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn().mockReturnValue(step),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = validateCheckpoint(repo, task.id, step.id, stepKey);

    expect(result.task).toBe(task);
    expect(result.currentStep).toBe(step);
  });

  it('throws TASK_NOT_FOUND when task does not exist', () => {
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(undefined),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, 'nonexistent', 'step-1', 'key');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.TASK_NOT_FOUND);
  });

  it('throws TASK_ALREADY_COMPLETED when task is not active', () => {
    const task = makeTask({ status: 'completed' });
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, task.id, 'step-1', 'key');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.TASK_ALREADY_COMPLETED);
  });

  it('throws INTERNAL_ERROR when no current step exists', () => {
    const task = makeTask();
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn().mockReturnValue(undefined),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, task.id, 'step-1', 'key');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INTERNAL_ERROR);
  });

  it('throws INVALID_CURRENT_STEP when stepId does not match current step', () => {
    const step = makeStep({ id: 'step-current' });
    const task = makeTask();
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn().mockReturnValue(step),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, task.id, 'step-wrong', 'key');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_CURRENT_STEP);
    expect((error as GateError).currentStep).toBeDefined();
    expect((error as GateError).currentStep!.stepId).toBe('step-current');
  });

  it('throws INVALID_STEP_KEY when step key hash does not match', () => {
    const stepKey = 'sg_step_real';
    const keyHash = hashKey(stepKey);
    const step = makeStep({ stepKeyHash: keyHash });
    const task = makeTask();
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn().mockReturnValue(step),
      getTaskSteps: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, task.id, step.id, 'sg_step_wrong_key');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_STEP_KEY);
    expect((error as GateError).currentStep).toBeDefined();
  });
});

// ============================================================================
// gate.ts tests — advanceStep
// ============================================================================

describe('advanceStep', () => {
  it('advances to the next step and returns nextStep info with key', () => {
    const task = makeTask({ totalSteps: 3 });
    const currentStep = makeStep({ id: 'step-1', orderIndex: 1, status: 'current' });
    const nextStepRow = makeStep({ id: 'step-2', orderIndex: 2, status: 'pending', path: 'Step 2' });

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue([currentStep, nextStepRow, makeStep({ id: 'step-3', orderIndex: 3, status: 'pending' })]),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceStep(repo, task, currentStep);

    expect(repo.completeAndAdvance).toHaveBeenCalledWith('step-1', 'step-2', expect.any(String), 'task-1', null);
    expect(result.nextStep).toBeDefined();
    expect(result.nextStep!.stepId).toBe('step-2');
    expect(result.nextStep!.path).toBe('Step 2');
    expect(result.nextStep!.index).toBe(2);
    expect(result.nextStep!.total).toBe(3);
    expect(result.nextStepKey).toBeDefined();
    expect(result.nextStepKey).toMatch(/^sg_step_/);
    expect(result.allStepsCompleted).toBeUndefined();
    expect(result.finalKey).toBeUndefined();
  });

  it('returns finalKey when no more steps remain', () => {
    const task = makeTask({ totalSteps: 2 });
    const currentStep = makeStep({ id: 'step-2', orderIndex: 2, status: 'current' });

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue([
        makeStep({ id: 'step-1', orderIndex: 1, status: 'completed' }),
        currentStep,
      ]),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceStep(repo, task, currentStep);

    expect(repo.completeAndAdvance).toHaveBeenCalledWith('step-2', null, null, 'task-1', expect.any(String));
    expect(result.allStepsCompleted).toBe(true);
    expect(result.finalKey).toBeDefined();
    expect(result.finalKey).toMatch(/^sg_final_/);
    expect(result.nextStep).toBeUndefined();
    expect(result.nextStepKey).toBeUndefined();
  });

  it('records step_completed event for completed step', () => {
    const task = makeTask({ totalSteps: 2 });
    const currentStep = makeStep({ id: 'step-1', orderIndex: 1, path: 'Phase / Step 1' });

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue([
        currentStep,
        makeStep({ id: 'step-2', orderIndex: 2, status: 'pending' }),
      ]),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceStep(repo, task, currentStep);

    expect(repo.completeAndAdvance).toHaveBeenCalledWith(
      currentStep.id,
      'step-2',
      expect.any(String),
      task.id,
      null
    );
    expect(result.nextStep).toBeDefined();
  });

  it('records all_steps_completed event on last step', () => {
    const task = makeTask({ totalSteps: 1 });
    const currentStep = makeStep({ id: 'step-1', orderIndex: 1 });

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentStep: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue([currentStep]),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceStep(repo, task, currentStep);

    expect(repo.completeAndAdvance).toHaveBeenCalledWith(
      currentStep.id,
      null,
      null,
      task.id,
      expect.any(String)
    );
    expect(result.allStepsCompleted).toBe(true);
  });
});
