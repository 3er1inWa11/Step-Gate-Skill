import { createHash, randomUUID } from 'node:crypto';
import db from './db.js';
import type { TaskRow, StepRow, EventRow } from '../types/index.js';
import { GateError, GateErrorCode } from '../core/errors.js';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

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
    dependsOn: row.depends_on ? (JSON.parse(row.depends_on as string) as string[]) : [],
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

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

export function createTask(task: TaskRow, steps: StepRow[]): void {
  if (!task || !task.id || !task.title) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Task must have id and title');
  }
  if (!steps || steps.length === 0) {
    throw new GateError(GateErrorCode.NO_STEPS, 'Task must have at least one step');
  }

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, title, status, current_index, total_steps, final_key_hash, created_at, updated_at)
    VALUES (@id, @title, @status, @currentIndex, @totalSteps, @finalKeyHash, @createdAt, @updatedAt)
  `);

  const insertStep = db.prepare(`
    INSERT INTO steps (id, task_id, parent_path, title, path, order_index, depends_on, status, step_key_hash, completed_at, created_at)
    VALUES (@id, @taskId, @parentPath, @title, @path, @orderIndex, @dependsOn, @status, @stepKeyHash, @completedAt, @createdAt)
  `);

  const transaction = db.transaction(() => {
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
        dependsOn: JSON.stringify(step.dependsOn),
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

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

export function getTask(taskId: string): TaskRow | undefined {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : undefined;
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get task: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getCurrentSteps — returns ALL steps with status='current' (DAG support)
// ---------------------------------------------------------------------------

export function getCurrentSteps(taskId: string): StepRow[] {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const rows = db
      .prepare("SELECT * FROM steps WHERE task_id = ? AND status = 'current' ORDER BY order_index ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(mapStepRow);
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get current steps: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getCurrentStep — legacy single-step query (for backward compat)
// ---------------------------------------------------------------------------

export function getCurrentStep(taskId: string): StepRow | undefined {
  const steps = getCurrentSteps(taskId);
  return steps.length > 0 ? steps[0] : undefined;
}

// ---------------------------------------------------------------------------
// getStep
// ---------------------------------------------------------------------------

export function getStep(stepId: string): StepRow | undefined {
  if (!stepId) {
    return undefined;
  }
  try {
    const row = db
      .prepare('SELECT * FROM steps WHERE id = ?')
      .get(stepId) as Record<string, unknown> | undefined;
    return row ? mapStepRow(row) : undefined;
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getTaskSteps
// ---------------------------------------------------------------------------

export function getTaskSteps(taskId: string): StepRow[] {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const rows = db
      .prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY order_index ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(mapStepRow);
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get task steps: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// completeStep (legacy, kept for test compat)
// ---------------------------------------------------------------------------

export function completeStep(stepId: string): void {
  if (!stepId) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, 'stepId is required');
  }
  try {
    const result = db
      .prepare(
        "UPDATE steps SET status = 'completed', step_key_hash = NULL, completed_at = ? WHERE id = ?",
      )
      .run(now(), stepId);
    if (result.changes === 0) {
      throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, `Step not found: ${stepId}`);
    }
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to complete step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// setCurrentStep (legacy, kept for test compat)
// ---------------------------------------------------------------------------

export function setCurrentStep(stepId: string, keyHash: string): void {
  if (!stepId) {
    throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, 'stepId is required');
  }
  try {
    const result = db
      .prepare("UPDATE steps SET status = 'current', step_key_hash = ? WHERE id = ?")
      .run(keyHash, stepId);
    if (result.changes === 0) {
      throw new GateError(GateErrorCode.INVALID_CURRENT_STEP, `Step not found: ${stepId}`);
    }
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to set current step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// updateTaskStatus
// ---------------------------------------------------------------------------

export function updateTaskStatus(taskId: string, status: string): void {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const result = db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), taskId);
    if (result.changes === 0) {
      throw new GateError(GateErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to update task status: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// setFinalKeyHash (legacy, kept for test compat)
// ---------------------------------------------------------------------------

export function setFinalKeyHash(taskId: string, hash: string): void {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const result = db
      .prepare('UPDATE tasks SET final_key_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, now(), taskId);
    if (result.changes === 0) {
      throw new GateError(GateErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to set final key hash: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// verifyStepKey
// ---------------------------------------------------------------------------

export function verifyStepKey(
  taskId: string,
  stepId: string,
  keyPlaintext: string,
): boolean {
  if (!taskId || !stepId || !keyPlaintext) {
    return false;
  }
  try {
    const step = db
      .prepare('SELECT step_key_hash FROM steps WHERE task_id = ? AND id = ?')
      .get(taskId, stepId) as { step_key_hash: string | null } | undefined;
    if (!step || !step.step_key_hash) return false;
    return sha256(keyPlaintext) === step.step_key_hash;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// verifyFinalKey
// ---------------------------------------------------------------------------

export function verifyFinalKey(taskId: string, keyPlaintext: string): boolean {
  if (!taskId || !keyPlaintext) {
    return false;
  }
  try {
    const task = db
      .prepare('SELECT final_key_hash FROM tasks WHERE id = ?')
      .get(taskId) as { final_key_hash: string | null } | undefined;
    if (!task || !task.final_key_hash) return false;
    return sha256(keyPlaintext) === task.final_key_hash;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// getActiveTasks — all tasks with status='active'
// ---------------------------------------------------------------------------

export function getActiveTasks(): TaskRow[] {
  try {
    const rows = db.prepare("SELECT * FROM tasks WHERE status = 'active'").all() as Record<string, unknown>[];
    return rows.map(mapTaskRow);
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get active tasks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getActiveTask — legacy single-task query (for backward compat)
// ---------------------------------------------------------------------------

export function getActiveTask(): TaskRow | undefined {
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE status = 'active' LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : undefined;
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get active task: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

export function cancelTask(taskId: string): void {
  updateTaskStatus(taskId, 'cancelled');
}

// ---------------------------------------------------------------------------
// addEvent
// ---------------------------------------------------------------------------

export function addEvent(
  taskId: string,
  stepId: string | null,
  eventType: string,
  payload?: string,
): void {
  if (!taskId || !eventType) {
    throw new GateError(GateErrorCode.INTERNAL_ERROR, 'taskId and eventType are required');
  }
  try {
    db.prepare(
      'INSERT INTO events (id, task_id, step_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), taskId, stepId, eventType, payload ?? null, now());
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to add event: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// completeAndAdvance — atomic completion + multi-step activation (DAG)
// ---------------------------------------------------------------------------

export function completeAndAdvance(
  completedStepId: string,
  nextStepIds: string[],
  nextKeyHashes: string[],
  taskId: string,
  finalKeyHash: string | null,
): void {
  const transaction = db.transaction(() => {
    // Complete current step
    db.prepare("UPDATE steps SET status = 'completed', step_key_hash = NULL, completed_at = ? WHERE id = ?")
      .run(now(), completedStepId);
    db.prepare("INSERT INTO events (id, task_id, step_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, completedStepId, 'step_completed', null, now());

    if (nextStepIds.length > 0) {
      // Activate all unlocked next steps
      for (let i = 0; i < nextStepIds.length; i++) {
        db.prepare("UPDATE steps SET status = 'current', step_key_hash = ? WHERE id = ?")
          .run(nextKeyHashes[i], nextStepIds[i]);
        db.prepare("INSERT INTO events (id, task_id, step_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), taskId, nextStepIds[i], 'step_activated', null, now());
      }
      // Update task timestamp
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(now(), taskId);
    } else if (finalKeyHash) {
      // All completed: store final key hash
      db.prepare('UPDATE tasks SET final_key_hash = ?, updated_at = ? WHERE id = ?')
        .run(finalKeyHash, now(), taskId);
      db.prepare("INSERT INTO events (id, task_id, step_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), taskId, null, 'all_steps_completed', null, now());
    }
    // else: no next steps and no finalKeyHash → just complete, don't activate anything (parallel branch await)
  });

  try {
    transaction();
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to advance step: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getEvents
// ---------------------------------------------------------------------------

export function getEvents(taskId: string): EventRow[] {
  if (!taskId) {
    throw new GateError(GateErrorCode.TASK_NOT_FOUND, 'taskId is required');
  }
  try {
    const rows = db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  } catch (err) {
    throw new GateError(
      GateErrorCode.INTERNAL_ERROR,
      `Failed to get events: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
