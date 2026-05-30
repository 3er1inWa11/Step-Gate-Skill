import { describe, it, expect, vi } from 'vitest';
import { generateStepKey, generateFinalKey, hashKey } from '../src/core/keys.js';
import { flattenPlan } from '../src/core/plan.js';
import { validateCheckpoint, advanceSteps } from '../src/core/gate.js';
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
      expect(plaintext).toMatch(/^[A-Z0-9]{6}$/);
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
    it('returns plaintext and hash as 6-char uppercase alphanumeric', () => {
      const { plaintext, hash } = generateFinalKey();
      expect(plaintext).toMatch(/^[A-Z0-9]{6}$/);
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

  it('step keys and final keys are 6-char uppercase alphanumeric codes', () => {
    const step = generateStepKey();
    const final = generateFinalKey();
    expect(step.plaintext).toMatch(/^[A-Z0-9]{6}$/);
    expect(final.plaintext).toMatch(/^[A-Z0-9]{6}$/);
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

  it('auto-serializes: no id, no dependsOn — each depends on the previous', () => {
    const nodes: PlanNode[] = [{ title: 'Step A' }, { title: 'Step B' }, { title: 'Step C' }];

    const result = flattenPlan(nodes, 'task-serial');

    expect(result).toHaveLength(3);
    expect(result[0].id).toMatch(/_step_1$/);
    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].id).toMatch(/_step_2$/);
    expect(result[1].dependsOn).toEqual([result[0].id]);
    expect(result[2].id).toMatch(/_step_3$/);
    expect(result[2].dependsOn).toEqual([result[1].id]);
  });

  it('uses explicit id when provided', () => {
    const nodes: PlanNode[] = [
      { id: 'init', title: 'Initialize' },
      { id: 'type', title: 'Types' },
    ];

    const result = flattenPlan(nodes, 'task-explicit');

    expect(result[0].id).toBe('task-explicit_init');
    expect(result[1].id).toBe('task-explicit_type');
    // Auto-serial: type depends on init (no explicit dependsOn)
    expect(result[1].dependsOn).toEqual(['task-explicit_init']);
  });

  it('respects explicit dependsOn over auto-serial', () => {
    const nodes: PlanNode[] = [
      { id: 'a', title: 'Step A' },
      { id: 'b', title: 'Step B', dependsOn: ['a'] },
      { id: 'c', title: 'Step C', dependsOn: ['b'] },
    ];

    const result = flattenPlan(nodes, 'task-deps');

    expect(result[0].dependsOn).toEqual([]);
    expect(result[1].dependsOn).toEqual(['task-deps_a']);
    expect(result[2].dependsOn).toEqual(['task-deps_b']);
  });

  it('supports DAG with parallel branches', () => {
    const nodes: PlanNode[] = [
      { id: 'init', title: 'Init' },
      { id: 'modA', title: 'Module A', dependsOn: ['init'] },
      { id: 'modB', title: 'Module B', dependsOn: ['init'] },
      { id: 'integrate', title: 'Integrate', dependsOn: ['modA', 'modB'] },
    ];

    const result = flattenPlan(nodes, 'task-dag');

    expect(result).toHaveLength(4);
    expect(result[0].dependsOn).toEqual([]);  // init: no deps
    expect(result[1].dependsOn).toEqual(['task-dag_init']); // modA
    expect(result[2].dependsOn).toEqual(['task-dag_init']); // modB
    expect(result[3].dependsOn).toEqual(['task-dag_modA', 'task-dag_modB']); // integrate
  });

  it('handles flat plan (no nesting) with auto serial', () => {
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
        { title: '' } as PlanNode,
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

    // F1: cycle detection
    it('detects simple 3-node cycle', () => {
      const nodes: PlanNode[] = [
        { id: 'a', title: 'Step A', dependsOn: ['c'] },
        { id: 'b', title: 'Step B', dependsOn: ['a'] },
        { id: 'c', title: 'Step C', dependsOn: ['b'] },
      ];

      expect(() => flattenPlan(nodes, 'task-cycle')).toThrow(GateError);
      try {
        flattenPlan(nodes, 'task-cycle');
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).code).toBe(GateErrorCode.PLAN_SCHEMA_INVALID);
        expect((e as GateError).message).toMatch(/Circular dependency/);
      }
    });

    it('detects self-referencing node', () => {
      const nodes: PlanNode[] = [
        { id: 'a', title: 'Step A', dependsOn: ['a'] },
      ];

      expect(() => flattenPlan(nodes, 'task-self')).toThrow(GateError);
      try {
        flattenPlan(nodes, 'task-self');
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).code).toBe(GateErrorCode.PLAN_SCHEMA_INVALID);
        expect((e as GateError).message).toMatch(/Circular dependency/);
      }
    });

    it('detects cycle through container expansion', () => {
      const nodes: PlanNode[] = [
        {
          id: 'setup',
          title: 'Setup',
          dependsOn: ['test'],
          children: [
            { id: 'db', title: 'DB' },
            { id: 'api', title: 'API' },
          ],
        },
        { id: 'test', title: 'Test', dependsOn: ['setup'] },
      ];

      expect(() => flattenPlan(nodes, 'task-container-cycle')).toThrow(GateError);
      try {
        flattenPlan(nodes, 'task-container-cycle');
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).code).toBe(GateErrorCode.PLAN_SCHEMA_INVALID);
        expect((e as GateError).message).toMatch(/Circular dependency/);
      }
    });

    it('does not flag a valid DAG as cyclic', () => {
      const nodes: PlanNode[] = [
        { id: 'init', title: 'Init' },
        { id: 'modA', title: 'Module A', dependsOn: ['init'] },
        { id: 'modB', title: 'Module B', dependsOn: ['init'] },
        { id: 'integrate', title: 'Integrate', dependsOn: ['modA', 'modB'] },
      ];

      const result = flattenPlan(nodes, 'task-dag-nocycle');
      expect(result).toHaveLength(4);
    });
  });

  // F3b: parent dependsOn propagation
  describe('F3b parent dependsOn propagation', () => {
    it('propagates parent dependsOn to children', () => {
      const nodes: PlanNode[] = [
        {
          id: 'parent',
          title: 'Parent',
          dependsOn: ['other'],
          children: [
            { id: 'c1', title: 'Child 1' },
            { id: 'c2', title: 'Child 2' },
          ],
        },
        { id: 'other', title: 'Other', dependsOn: [] },
      ];

      const result = flattenPlan(nodes, 'task-f3b');

      // c1 should depend on other
      const c1 = result.find(r => r.id === 'task-f3b_c1')!;
      expect(c1.dependsOn).toContain('task-f3b_other');

      // c2 should also depend on other
      const c2 = result.find(r => r.id === 'task-f3b_c2')!;
      expect(c2.dependsOn).toContain('task-f3b_other');

      // other has explicit empty deps
      const other = result.find(r => r.id === 'task-f3b_other')!;
      expect(other.dependsOn).toEqual([]);
    });

    it('merges parent and child dependsOn', () => {
      const nodes: PlanNode[] = [
        {
          id: 'container',
          title: 'Container',
          dependsOn: ['init'],
          children: [
            { id: 'task', title: 'Task', dependsOn: ['config'] },
          ],
        },
        { id: 'init', title: 'Init' },
        { id: 'config', title: 'Config' },
      ];

      const result = flattenPlan(nodes, 'task-merge');

      // task should depend on BOTH init (inherited) and config (own)
      const task = result.find(r => r.id === 'task-merge_task')!;
      expect(task.dependsOn).toContain('task-merge_init');
      expect(task.dependsOn).toContain('task-merge_config');
    });

    it('propagates through multiple nesting levels', () => {
      const nodes: PlanNode[] = [
        {
          id: 'l1',
          title: 'Level 1',
          dependsOn: ['prereq'],
          children: [
            {
              id: 'l2',
              title: 'Level 2',
              dependsOn: ['setup'],
              children: [
                { id: 'leaf', title: 'Leaf' },
              ],
            },
          ],
        },
        { id: 'prereq', title: 'Prereq' },
        { id: 'setup', title: 'Setup' },
      ];

      const result = flattenPlan(nodes, 'task-deep');

      // leaf should inherit deps from BOTH l1 and l2
      const leaf = result.find(r => r.id === 'task-deep_leaf')!;
      expect(leaf.dependsOn).toContain('task-deep_prereq');
      expect(leaf.dependsOn).toContain('task-deep_setup');
    });

    it('empty dependsOn on parent does not affect child auto-serial', () => {
      const nodes: PlanNode[] = [
        {
          id: 'p',
          title: 'Parent',
          dependsOn: [],
          children: [
            { title: 'Child A' },
            { title: 'Child B' },
          ],
        },
      ];

      const result = flattenPlan(nodes, 'task-empty-inherit');

      expect(result).toHaveLength(2);
      // Children should auto-serialize since parent had empty deps and no own deps
      expect(result[0].dependsOn).toEqual([]);
      expect(result[1].dependsOn).toEqual([result[0].id]);
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
    dependsOn: [],
    status: 'current',
    stepKeyHash: null,
    completedAt: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateCheckpoint', () => {
  it('returns task and currentStep on successful validation', () => {
    const stepKey = 'A3K9X2';
    const keyHash = hashKey(stepKey);
    const step = makeStep({ stepKeyHash: keyHash });
    const task = makeTask();

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn().mockReturnValue([step]),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
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
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
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
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
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
      getCurrentSteps: vi.fn().mockReturnValue([]),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
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

  it('throws INVALID_CURRENT_STEP when stepId does not match any current step', () => {
    const step = makeStep({ id: 'step-current' });
    const task = makeTask();
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn().mockReturnValue([step]),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
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
    const stepKey = 'Z7MPQ1';
    const keyHash = hashKey(stepKey);
    const step = makeStep({ stepKeyHash: keyHash });
    const task = makeTask();
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn().mockReturnValue([step]),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    let error: unknown = null;
    try {
      validateCheckpoint(repo, task.id, step.id, 'WRONG1');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(GateErrorCode.INVALID_STEP_KEY);
    expect((error as GateError).currentStep).toBeDefined();
  });

  it('accepts checkpoint for any of multiple current steps (DAG)', () => {
    const stepA = makeStep({ id: 'step-a', orderIndex: 1, stepKeyHash: hashKey('KEYAAAA') });
    const stepB = makeStep({ id: 'step-b', orderIndex: 2, stepKeyHash: hashKey('KEYBBBB') });
    const task = makeTask({ totalSteps: 4 });
    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn().mockReturnValue([stepA, stepB]),
      getTaskSteps: vi.fn(),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    // Can validate step-b (second current step)
    const result = validateCheckpoint(repo, task.id, 'step-b', 'KEYBBBB');
    expect(result.currentStep.id).toBe('step-b');
  });
});

// ============================================================================
// gate.ts tests — advanceSteps (DAG)
// ============================================================================

describe('advanceSteps', () => {
  it('activates multiple next steps when dependencies are all satisfied', () => {
    // DAG: init → modA, init → modB, [modA, modB] → integrate
    const init = makeStep({ id: 'init', orderIndex: 1, dependsOn: [], status: 'current' });
    const modA = makeStep({ id: 'modA', orderIndex: 2, dependsOn: ['init'], status: 'pending' });
    const modB = makeStep({ id: 'modB', orderIndex: 3, dependsOn: ['init'], status: 'pending', path: 'Module B' });
    const integrate = makeStep({ id: 'integrate', orderIndex: 4, dependsOn: ['modA', 'modB'], status: 'pending', path: 'Integrate' });
    const task = makeTask({ totalSteps: 4 });

    const allSteps = [init, modA, modB, integrate];

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue(allSteps),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    // Complete 'init' → both modA and modB should unlock
    const result = advanceSteps(repo, task, 'init');

    expect(repo.completeAndAdvance).toHaveBeenCalledWith(
      'init',
      ['modA', 'modB'],
      expect.any(Array),
      'task-1',
      null
    );
    const callArgs = (repo.completeAndAdvance as any).mock.calls[0];
    expect(callArgs[1]).toHaveLength(2);
    expect(callArgs[2]).toHaveLength(2);
    expect(result.nextSteps).toBeDefined();
    expect(result.nextSteps!.length).toBe(2);
    expect(result.nextStepKeys).toBeDefined();
    expect(Object.keys(result.nextStepKeys!)).toHaveLength(2);
  });

  it('does not activate a step when not all deps are met (parallel branch)', () => {
    // init → modA, init → modB (parallel branches)
    const init = makeStep({ id: 'init', orderIndex: 1, dependsOn: [], status: 'completed' });
    const modA = makeStep({ id: 'modA', orderIndex: 2, dependsOn: ['init'], status: 'current' });
    const modB = makeStep({ id: 'modB', orderIndex: 3, dependsOn: ['init'], status: 'current', path: 'Module B' });
    const integrate = makeStep({ id: 'integrate', orderIndex: 4, dependsOn: ['modA', 'modB'], status: 'pending', path: 'Integrate' });
    const task = makeTask({ totalSteps: 4 });

    const allSteps = [init, modA, modB, integrate];

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue(allSteps),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    // Complete modA — integrate should NOT unlock (modB still pending)
    const result = advanceSteps(repo, task, 'modA');

    expect(repo.completeAndAdvance).toHaveBeenCalledWith('modA', [], [], 'task-1', null);
    expect(result.nextSteps).toBeUndefined();
    expect(result.nextStepKeys).toBeUndefined();
    expect(result.allStepsCompleted).toBeUndefined();
  });

  it('returns taskKey when last step completes all', () => {
    const step1 = makeStep({ id: 'step-2', orderIndex: 2, dependsOn: [], status: 'current' });
    const task = makeTask({ totalSteps: 2 });

    const allSteps = [
      makeStep({ id: 'step-1', orderIndex: 1, dependsOn: [], status: 'completed' }),
      step1,
    ];

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue(allSteps),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceSteps(repo, task, 'step-2');

    expect(repo.completeAndAdvance).toHaveBeenCalledWith('step-2', [], [], 'task-1', expect.any(String));
    expect(result.allStepsCompleted).toBe(true);
    expect(result.taskKey).toBeDefined();
    expect(result.taskKey).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('activates unlocked step in simple serial case', () => {
    const step1 = makeStep({ id: 'step-1', orderIndex: 1, dependsOn: [], status: 'current' });
    const step2 = makeStep({ id: 'step-2', orderIndex: 2, dependsOn: ['step-1'], status: 'pending', path: 'Step 2' });
    const task = makeTask({ totalSteps: 3 });
    const allSteps = [step1, step2, makeStep({ id: 'step-3', orderIndex: 3, dependsOn: ['step-2'], status: 'pending' })];

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue(allSteps),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceSteps(repo, task, 'step-1');

    expect(repo.completeAndAdvance).toHaveBeenCalledWith('step-1', ['step-2'], expect.any(Array), 'task-1', null);
    expect(result.nextSteps).toBeDefined();
    expect(result.nextSteps![0].stepId).toBe('step-2');
    expect(result.nextSteps![0].path).toBe('Step 2');
    expect(result.nextSteps![0].index).toBe(2);
    expect(result.nextSteps![0].total).toBe(3);
    expect(result.nextStepKeys).toBeDefined();
    expect(Object.keys(result.nextStepKeys!)[0]).toBe('step-2');
    const key = (result.nextStepKeys as any)['step-2'];
    expect(key).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('returns empty object when completing parallel branch while other branches run', () => {
    // Two parallel branches: init→modA, init→modB. Both are current (after init completed).
    // Complete modA — nothing unlocks because modB is still current.
    const modA = makeStep({ id: 'modA', orderIndex: 2, dependsOn: ['init'], status: 'current' });
    const task = makeTask({ totalSteps: 4 });
    const allSteps = [
      makeStep({ id: 'init', orderIndex: 1, dependsOn: [], status: 'completed' }),
      modA,
      makeStep({ id: 'modB', orderIndex: 3, dependsOn: ['init'], status: 'current' }),
      makeStep({ id: 'integrate', orderIndex: 4, dependsOn: ['modA', 'modB'], status: 'pending' }),
    ];

    const repo: GateRepository = {
      getTask: vi.fn().mockReturnValue(task),
      getCurrentSteps: vi.fn(),
      getTaskSteps: vi.fn().mockReturnValue(allSteps),
      getStep: vi.fn(),
      completeAndAdvance: vi.fn(),
      updateTaskStatus: vi.fn(),
      verifyFinalKey: vi.fn(),
    };

    const result = advanceSteps(repo, task, 'modA');

    // Should complete modA with no next steps activated
    expect(repo.completeAndAdvance).toHaveBeenCalledWith('modA', [], [], 'task-1', null);
    expect(result.nextSteps).toBeUndefined();
    expect(result.allStepsCompleted).toBeUndefined();
  });
});
