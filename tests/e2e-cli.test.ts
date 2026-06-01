/**
 * E2E CLI: 核心工作流 + DAG + 多 Agent 模拟
 *
 * Uses a temp CWD to isolate the test DB from the dev DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const TMP = resolve(tmpdir(), `stepgate-e2e-${randomUUID().slice(0, 8)}`);
const STEPGATE = resolve(TMP, '.step-gate');
const DB_PATH = resolve(STEPGATE, 'gate.db');

function run(...args: string[]): string {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: TMP, encoding: 'utf-8', timeout: 10_000,
  });
  if (r.error) throw r.error;
  return (r.stdout || '').trim() || r.stderr || '';
}

function j(...args: string[]): any {
  const out = run(...args);
  try { return JSON.parse(out); } catch { throw new Error(`ParseFail >>>${out}<<<`); }
}

describe('E2E CLI', () => {
  beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    mkdirSync(STEPGATE, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  // ============================================================
  // Basic flow
  // ============================================================

  it('1. start-plan → checkpoint → finalize', () => {
    // Create
    const s = j('start-plan', '{"title":"basic","steps":[{"id":"a","title":"Step A","dependsOn":[]}]}');
    expect(s.ok).toBe(true);
    expect(s.taskId).toMatch(/^tsk_/);
    expect(s.currentSteps).toHaveLength(1);
    const stepId = s.currentSteps[0].stepId;
    const stepKey = s.stepKeys[stepId];
    expect(stepKey).toBeTruthy();

    // Checkpoint
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepId}","stepKey":"${stepKey}"}`);
    expect(c.ok).toBe(true);
    expect(c.allStepsCompleted).toBe(true);
    expect(c.taskKey).toMatch(/^[A-Z0-9]{6}$/);

    // Finalize
    const f = j('finalize', `{"taskId":"${s.taskId}","taskKey":"${c.taskKey}"}`);
    expect(f.ok).toBe(true);
    expect(f.level).toBe('task');
  });

  // ============================================================
  // DB location
  // ============================================================

  it('2. DB is in .step-gate/ under CWD', () => {
    expect(existsSync(DB_PATH)).toBe(true);
  });

  // ============================================================
  // current command
  // ============================================================

  it('3. current reads progress, never returns keys', () => {
    const s = j('start-plan', '{"title":"current test","steps":[{"id":"x","title":"X","dependsOn":[]}]}');
    const cur = j('current', `{"taskId":"${s.taskId}"}`);
    expect(cur.status).toBe('active');
    expect(cur.currentSteps).toHaveLength(1);
    // Must NOT leak keys
    expect(cur.stepKeys).toBeUndefined();
    expect(cur.currentSteps[0].stepKey).toBeUndefined();
  });

  // ============================================================
  // Key validation
  // ============================================================

  it('4. wrong key rejected', () => {
    const s = j('start-plan', '{"title":"wrong key","steps":[{"id":"w","title":"W","dependsOn":[]}]}');
    const sid = s.currentSteps[0].stepId;
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"AAAAAA"}`);
    expect(c.ok).toBe(false);
    expect(c.error).toBe('INVALID_STEP_KEY');
  });

  it('5. double consumption fails', () => {
    const s = j('start-plan', '{"title":"double","steps":[{"id":"d","title":"D","dependsOn":[]}]}');
    const sid = s.currentSteps[0].stepId;
    const key = s.stepKeys[sid];
    // First consumption: ok
    expect(j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${key}"}`).ok).toBe(true);
    // Second consumption: rejected
    const c2 = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${key}"}`);
    expect(c2.ok).toBe(false);
  });

  it('6. finalize wrong taskKey rejected', () => {
    const s = j('start-plan', '{"title":"finalize reject","steps":[{"id":"f","title":"F","dependsOn":[]}]}');
    const sid = s.currentSteps[0].stepId;
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${s.stepKeys[sid]}"}`);
    // Try wrong taskKey
    const f = j('finalize', `{"taskId":"${s.taskId}","taskKey":"WRONG1"}`);
    expect(f.ok).toBe(false);
  });

  // ============================================================
  // DAG parallel branches
  // ============================================================

  it('7. DAG: parallel entries activate', () => {
    const s = j('start-plan',
      '{"title":"DAG parallel","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}' +
      ']}');
    expect(s.ok).toBe(true);
    expect(s.currentSteps).toHaveLength(2);
    const paths = s.currentSteps.map((x: any) => x.path);
    expect(paths).toContain('A');
    expect(paths).toContain('B');
  });

  it('8. DAG: one branch done = no merge yet', () => {
    const s = j('start-plan',
      '{"title":"DAG partial","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}' +
      ']}');
    const stepA = s.currentSteps.find((x: any) => x.path === 'A');
    const keyA = s.stepKeys[stepA.stepId];
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepA.stepId}","stepKey":"${keyA}"}`);
    expect(c.ok).toBe(true);
    // Merge point C should NOT unlock yet (B still pending)
    expect(c.nextSteps).toBeUndefined();
  });

  it('9. DAG: both branches done = merge unlocks', () => {
    const s = j('start-plan',
      '{"title":"DAG full","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}' +
      ']}');
    // Complete A
    const stepA = s.currentSteps.find((x: any) => x.path === 'A');
    const cA = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepA.stepId}","stepKey":"${s.stepKeys[stepA.stepId]}"}`);
    expect(cA.ok).toBe(true);

    // B should still be current
    const cur = j('current', `{"taskId":"${s.taskId}"}`);
    const stepB = cur.currentSteps.find((x: any) => x.path === 'B');
    const keyB = s.stepKeys[stepB.stepId]; // keys from start-plan
    expect(keyB).toBeTruthy();

    const cB = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepB.stepId}","stepKey":"${keyB}"}`);
    expect(cB.ok).toBe(true);
    // C should now be unlocked
    expect(cB.nextSteps).toBeDefined();
    expect(cB.nextSteps[0].path).toBe('C');
  });

  // ============================================================
  // active-task cross-session
  // ============================================================

  it('10. active-task shows all tasks (cross-session default)', () => {
    j('start-plan', '{"title":"active test","steps":[{"id":"at","title":"AT","dependsOn":[]}]}');
    const r = j('active-task');
    expect(r.activeTasks.length).toBeGreaterThan(0);
    // Should include sessionId in response
    expect(r.activeTasks[0].sessionId).toBeTruthy();
  });

  // ============================================================
  // Program layer
  // ============================================================

  it('11. program init → status', () => {
    const init = j('program', 'init',
      '{"title":"E2E Program","nodes":[' +
      '{"id":"p1","title":"Phase 1","dependsOn":[]},' +
      '{"id":"p2","title":"Phase 2","dependsOn":["p1"]}' +
      ']}');
    expect(init.ok).toBe(true);
    expect(init.programId).toMatch(/^pgm_/);

    const st = j('program', 'status', `{"programId":"${init.programId}"}`);
    expect(st.title).toBe('E2E Program');
  });
});
