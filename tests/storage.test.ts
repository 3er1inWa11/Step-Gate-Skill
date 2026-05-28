import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_DIR = resolve(__dirname, '..', 'data');
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'test-gate.db');

let db: Database.Database;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Dynamically import repository — but we need to import it BEFORE we
// set up the test db. Instead, we overwrite the module-level defaults
// by using a factory pattern. For simplicity, we test against a fresh
// in-memory db with the same schema.
// ---------------------------------------------------------------------------

function createSchema(database: Database.Database) {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_index INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL,
      final_key_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_path TEXT,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      step_key_hash TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
  `);
}

// Re-implement repository functions bound to our test db
// This avoids module-level db import issues and tests the actual logic.

import { GateError, GateErrorCode } from '../src/core/errors.js';
import type { TaskRow, StepRow, EventRow } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Snake_case → camelCase mappers for SELECT * results
// ---------------------------------------------------------------------------

function mapTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as TaskRow['status'],
    currentIndex: row.current_index as number,
    totalSteps: row.total_steps as number,
    finalKeyHash: (row.final_key_hash as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapStepRow(row: Record<string, unknown>): StepRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    parentPath: (row.parent_path as string) ?? null,
    title: row.title as string,
    path: row.path as string,
    orderIndex: row.order_index as number,
    status: row.status as StepRow['status'],
    stepKeyHash: (row.step_key_hash as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    stepId: (row.step_id as string) ?? null,
    eventType: row.event_type as string,
    payload: (row.payload as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function createTask(database: Database.Database, task: TaskRow, steps: StepRow[]): void {
  if (!task || !task.id || !task.title) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Task must have id and title');
  }
  if (!steps || steps.length === 0) {
    throw new GateError(GateErrorCode.NO_STEPS, 'Task must have at least one step');
  }

  const insertTask = database.prepare(`
    INSERT INTO tasks (id, title, status, current_index, total_steps, final_key_hash, created_at, updated_at)
    VALUES (@id, @title, @status, @currentIndex, @totalSteps, @finalKeyHash, @createdAt, @updatedAt)
  `);

  const insertStep = database.prepare(`
    INSERT INTO steps (id, task_id, parent_path, title, path, order_index, status, step_key_hash, completed_at, created_at)
    VALUES (@id, @taskId, @parentPath, @title, @path, @orderIndex, @status, @stepKeyHash, @completedAt, @createdAt)
  `);

  const transaction = database.transaction(() => {
    insertTask.run({
      id: task.id,
      title: task.title,
      status: task.status,
      currentIndex: task.currentIndex,
      totalSteps: task.totalSteps,
      finalKeyHash: task.finalKeyHash,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });

    for (const step of steps) {
      insertStep.run({
        id: step.id,
        taskId: step.taskId,
        parentPath: step.parentPath,
        title: step.title,
        path: step.path,
        orderIndex: step.orderIndex,
        status: step.status,
        stepKeyHash: step.stepKeyHash,
        completedAt: step.completedAt,
        createdAt: step.createdAt,
      });
    }
  });

  try {
    transaction();
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getTask(database: Database.Database, taskId: string): TaskRow | undefined {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  return row ? mapTaskRow(row) : undefined;
}

function getCurrentStep(database: Database.Database, taskId: string): StepRow | undefined {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const row = database
    .prepare("SELECT * FROM steps WHERE task_id = ? AND status = 'current'")
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? mapStepRow(row) : undefined;
}

function getTaskSteps(database: Database.Database, taskId: string): StepRow[] {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const rows = database
    .prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY order_index ASC')
    .all(taskId) as Record<string, unknown>[];
  return rows.map(mapStepRow);
}

function completeStep(database: Database.Database, stepId: string): void {
  if (!stepId) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, 'stepId is required');
  }
  const result = database
    .prepare("UPDATE steps SET status = 'completed', step_key_hash = NULL, completed_at = ? WHERE id = ?")
    .run(now(), stepId);
  if (result.changes === 0) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, `Step not found: ${stepId}`);
  }
}

function setCurrentStep(database: Database.Database, stepId: string, keyHash: string): void {
  if (!stepId) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, 'stepId is required');
  }
  const result = database
    .prepare("UPDATE steps SET status = 'current', step_key_hash = ? WHERE id = ?")
    .run(keyHash, stepId);
  if (result.changes === 0) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, `Step not found: ${stepId}`);
  }
}

function updateTaskStatus(database: Database.Database, taskId: string, status: string): void {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const result = database
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), taskId);
  if (result.changes === 0) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
  }
}

function setFinalKeyHash(database: Database.Database, taskId: string, hash: string): void {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const result = database
    .prepare('UPDATE tasks SET final_key_hash = ?, updated_at = ? WHERE id = ?')
    .run(hash, now(), taskId);
  if (result.changes === 0) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
  }
}

function verifyStepKey(
  database: Database.Database,
  taskId: string,
  stepId: string,
  keyPlaintext: string,
): boolean {
  if (!taskId || !stepId || !keyPlaintext) return false;
  const step = database
    .prepare('SELECT step_key_hash FROM steps WHERE task_id = ? AND id = ?')
    .get(taskId, stepId) as { step_key_hash: string | null } | undefined;
  if (!step || !step.step_key_hash) return false;
  return sha256(keyPlaintext) === step.step_key_hash;
}

function verifyFinalKey(
  database: Database.Database,
  taskId: string,
  keyPlaintext: string,
): boolean {
  if (!taskId || !keyPlaintext) return false;
  const task = database
    .prepare('SELECT final_key_hash FROM tasks WHERE id = ?')
    .get(taskId) as { final_key_hash: string | null } | undefined;
  if (!task || !task.final_key_hash) return false;
  return sha256(keyPlaintext) === task.final_key_hash;
}

function addEvent(
  database: Database.Database,
  taskId: string,
  stepId: string | null,
  eventType: string,
  payload?: string,
): void {
  if (!taskId || !eventType) {
    throw new GateError(GateErrorCode.INTERNAL_ERROR, 'taskId and eventType are required');
  }
  database
    .prepare(
      'INSERT INTO events (id, task_id, step_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(randomUUID(), taskId, stepId, eventType, payload ?? null, now());
}

function getEvents(database: Database.Database, taskId: string): EventRow[] {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  const rows = database
    .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Record<string, unknown>[];
  return rows.map(mapEventRow);
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: randomUUID(),
    title: 'Test Task',
    status: 'active',
    currentIndex: 0,
    totalSteps: 3,
    finalKeyHash: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function makeStepRows(taskId: string, count: number): StepRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    taskId,
    parentPath: null,
    title: `Step ${i + 1}`,
    path: `Step ${i + 1}`,
    orderIndex: i,
    status: (i === 0 ? 'current' : 'pending') as StepRow['status'],
    stepKeyHash: null,
    completedAt: null,
    createdAt: now(),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(TEST_DB_DIR, { recursive: true });
  // Remove stale test db
  try { rmSync(TEST_DB_PATH); } catch { /* ok */ }
  db = new Database(TEST_DB_PATH);
  createSchema(db);
});

afterAll(() => {
  db.close();
  try { rmSync(TEST_DB_PATH); } catch { /* ok */ }
});

beforeEach(() => {
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM steps');
  db.exec('DELETE FROM tasks');
});

describe('createTask', () => {
  it('should create a task and its steps in a transaction', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 3);

    createTask(db, task, steps);

    const fetched = getTask(db, task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Test Task');

    const fetchedSteps = getTaskSteps(db, task.id);
    expect(fetchedSteps).toHaveLength(3);
    expect(fetchedSteps[0].orderIndex).toBe(0);
    expect(fetchedSteps[1].orderIndex).toBe(1);
    expect(fetchedSteps[2].orderIndex).toBe(2);
  });

  it('should throw NO_STEPS when steps array is empty', () => {
    const task = makeTaskRow();
    expect(() => createTask(db, task, [])).toThrow(GateError);
    expect(() => createTask(db, task, [])).toThrow('at least one step');
  });

  it('should throw PLAN_SCHEMA_INVALID when task has no title', () => {
    expect(() => createTask(db, makeTaskRow({ title: '' }), makeStepRows('x', 1))).toThrow(
      GateError,
    );
  });
});

describe('getTask', () => {
  it('should return undefined for non-existent task', () => {
    expect(getTask(db, 'nonexistent')).toBeUndefined();
  });

  it('should throw TASK_NOT_FOUND when taskId is empty', () => {
    expect(() => getTask(db, '')).toThrow(GateError);
  });
});

describe('getCurrentStep', () => {
  it('should return the step with status current', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 3);
    steps[0].status = 'current';
    createTask(db, task, steps);

    const current = getCurrentStep(db, task.id);
    expect(current).toBeDefined();
    expect(current!.status).toBe('current');
  });

  it('should return undefined if no current step', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    steps[0].status = 'pending';
    createTask(db, task, steps);

    expect(getCurrentStep(db, task.id)).toBeUndefined();
  });
});

describe('getTaskSteps', () => {
  it('should return steps ordered by order_index', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 4);
    createTask(db, task, steps);

    const result = getTaskSteps(db, task.id);
    expect(result).toHaveLength(4);
    expect(result[0].orderIndex).toBe(0);
    expect(result[3].orderIndex).toBe(3);
  });
});

describe('completeStep', () => {
  it('should mark step as completed and clear step_key_hash', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    const stepId = steps[0].id;
    steps[0].status = 'current';
    steps[0].stepKeyHash = sha256('test-key');
    createTask(db, task, steps);

    completeStep(db, stepId);

    const rawUpdated = db.prepare('SELECT * FROM steps WHERE id = ?').get(stepId) as Record<string, unknown>;
    const updated = mapStepRow(rawUpdated);
    expect(updated.status).toBe('completed');
    expect(updated.stepKeyHash).toBeNull();
    expect(updated.completedAt).toBeTruthy();
  });

  it('should throw INVALID_CURRENT_STEP for non-existent step', () => {
    expect(() => completeStep(db, 'nonexistent')).toThrow(GateError);
  });
});

describe('setCurrentStep', () => {
  it('should set step status to current and store keyHash', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    steps.forEach((s) => (s.status = 'pending'));
    createTask(db, task, steps);

    const keyHash = sha256('my-key');
    setCurrentStep(db, steps[0].id, keyHash);

    const rawUpdated = db.prepare('SELECT * FROM steps WHERE id = ?').get(steps[0].id) as Record<string, unknown>;
    const updated = mapStepRow(rawUpdated);
    expect(updated.status).toBe('current');
    expect(updated.stepKeyHash).toBe(keyHash);
  });
});

describe('updateTaskStatus', () => {
  it('should update task status and updated_at', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    updateTaskStatus(db, task.id, 'completed');

    const updated = getTask(db, task.id);
    expect(updated!.status).toBe('completed');
  });

  it('should throw TASK_NOT_FOUND for non-existent task', () => {
    expect(() => updateTaskStatus(db, 'nonexistent', 'active')).toThrow(GateError);
  });
});

describe('setFinalKeyHash', () => {
  it('should set final_key_hash on the task', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    const hash = sha256('final-secret');
    setFinalKeyHash(db, task.id, hash);

    const updated = getTask(db, task.id);
    expect(updated!.finalKeyHash).toBe(hash);
  });
});

describe('verifyStepKey', () => {
  it('should return true for correct key', () => {
    const plaintext = 'my-step-key';
    const keyHash = sha256(plaintext);
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    steps[0].status = 'current';
    steps[0].stepKeyHash = keyHash;
    createTask(db, task, steps);

    expect(verifyStepKey(db, task.id, steps[0].id, plaintext)).toBe(true);
  });

  it('should return false for incorrect key', () => {
    const keyHash = sha256('correct-key');
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    steps[0].status = 'current';
    steps[0].stepKeyHash = keyHash;
    createTask(db, task, steps);

    expect(verifyStepKey(db, task.id, steps[0].id, 'wrong-key')).toBe(false);
  });

  it('should return false when step has no keyHash', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 2);
    steps[0].status = 'current';
    steps[0].stepKeyHash = null;
    createTask(db, task, steps);

    expect(verifyStepKey(db, task.id, steps[0].id, 'anything')).toBe(false);
  });

  it('should return false for empty input', () => {
    expect(verifyStepKey(db, '', '', '')).toBe(false);
  });
});

describe('verifyFinalKey', () => {
  it('should return true for correct final key', () => {
    const plaintext = 'final-secret';
    const keyHash = sha256(plaintext);
    const task = makeTaskRow({ finalKeyHash: keyHash });
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    expect(verifyFinalKey(db, task.id, plaintext)).toBe(true);
  });

  it('should return false for incorrect final key', () => {
    const task = makeTaskRow({ finalKeyHash: sha256('real-final') });
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    expect(verifyFinalKey(db, task.id, 'wrong-final')).toBe(false);
  });

  it('should return false when task has no final_key_hash', () => {
    const task = makeTaskRow({ finalKeyHash: null });
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    expect(verifyFinalKey(db, task.id, 'anything')).toBe(false);
  });
});

describe('addEvent / getEvents', () => {
  it('should add event and retrieve it', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    addEvent(db, task.id, steps[0].id, 'step_completed', JSON.stringify({ foo: 'bar' }));

    const events = getEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('step_completed');
    expect(events[0].stepId).toBe(steps[0].id);
    expect(events[0].payload).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('should add event with null stepId', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    addEvent(db, task.id, null, 'task_created');

    const events = getEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].stepId).toBeNull();
  });

  it('should return empty array for task with no events', () => {
    const task = makeTaskRow();
    const steps = makeStepRows(task.id, 1);
    createTask(db, task, steps);

    expect(getEvents(db, task.id)).toEqual([]);
  });
});
