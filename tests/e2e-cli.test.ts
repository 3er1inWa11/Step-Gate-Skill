import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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

  it('1. start-plan -> checkpoint -> finalize', () => {
    const s = j('start-plan', '{"title":"basic","steps":[{"id":"a","title":"A","dependsOn":[]}]}');
    expect(s.ok).toBe(true);
    expect(s.taskId).toMatch(/^tsk_/);
    const stepId = s.currentSteps[0].stepId;
    const key = s.stepKeys[stepId];
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepId}","stepKey":"${key}"}`);
    expect(c.ok).toBe(true);
    expect(c.allStepsCompleted).toBe(true);
    const f = j('finalize', `{"taskId":"${s.taskId}","taskKey":"${c.taskKey}"}`);
    expect(f.ok).toBe(true);
  });

  it('2. DB in .step-gate/', () => {
    expect(existsSync(DB_PATH)).toBe(true);
  });

  it('3. current no key leak', () => {
    const s = j('start-plan', '{"title":"ct","steps":[{"id":"x","title":"X","dependsOn":[]}]}');
    const cur = j('current', `{"taskId":"${s.taskId}"}`);
    expect(cur.status).toBe('active');
    expect(cur.stepKeys).toBeUndefined();
    expect(cur.currentSteps[0].stepKey).toBeUndefined();
  });

  it('4. wrong key rejected', () => {
    const s = j('start-plan', '{"title":"wk","steps":[{"id":"w","title":"W","dependsOn":[]}]}');
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${s.currentSteps[0].stepId}","stepKey":"AAAAAA"}`);
    expect(c.ok).toBe(false);
    expect(c.error).toBe('INVALID_STEP_KEY');
  });

  it('5. double consumption fails', () => {
    const s = j('start-plan', '{"title":"dc","steps":[{"id":"d","title":"D","dependsOn":[]}]}');
    const sid = s.currentSteps[0].stepId;
    const key = s.stepKeys[sid];
    expect(j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${key}"}`).ok).toBe(true);
    expect(j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${key}"}`).ok).toBe(false);
  });

  it('6. finalize wrong taskKey rejected', () => {
    const s = j('start-plan', '{"title":"fr","steps":[{"id":"f","title":"F","dependsOn":[]}]}');
    const sid = s.currentSteps[0].stepId;
    j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${sid}","stepKey":"${s.stepKeys[sid]}"}`);
    const f = j('finalize', `{"taskId":"${s.taskId}","taskKey":"WRONG1"}`);
    expect(f.ok).toBe(false);
  });

  it('7. DAG parallel entries', () => {
    const s = j('start-plan', '{"title":"dp","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}]}');
    expect(s.currentSteps).toHaveLength(2);
    expect(s.currentSteps.map((x:any)=>x.path)).toEqual(expect.arrayContaining(['A','B']));
  });

  it('8. DAG partial merge', () => {
    const s = j('start-plan', '{"title":"dm","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}]}');
    const stepA = s.currentSteps.find((x:any)=>x.path==='A');
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepA.stepId}","stepKey":"${s.stepKeys[stepA.stepId]}"}`);
    expect(c.ok).toBe(true);
    expect(c.nextSteps).toBeUndefined(); // B still pending
  });

  it('9. DAG full merge', () => {
    const s = j('start-plan', '{"title":"df","steps":[' +
      '{"id":"a","title":"A","dependsOn":[]},' +
      '{"id":"b","title":"B","dependsOn":[]},' +
      '{"id":"c","title":"C","dependsOn":["a","b"]}]}');
    const stepA = s.currentSteps.find((x:any)=>x.path==='A');
    j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepA.stepId}","stepKey":"${s.stepKeys[stepA.stepId]}"}`);
    const cur = j('current', `{"taskId":"${s.taskId}"}`);
    const stepB = cur.currentSteps.find((x:any)=>x.path==='B');
    const c = j('checkpoint', `{"taskId":"${s.taskId}","stepId":"${stepB.stepId}","stepKey":"${s.stepKeys[stepB.stepId]}"}`);
    expect(c.nextSteps).toBeDefined();
    expect(c.nextSteps[0].path).toBe('C');
  });

  it('10. active-task cross-session', () => {
    j('start-plan', '{"title":"at","steps":[{"id":"at","title":"AT","dependsOn":[]}]}');
    const r = j('active-task');
    expect(r.activeTasks.length).toBeGreaterThan(0);
    expect(r.activeTasks[0].sessionId).toBeTruthy();
  });

  it('11. program init -> status', () => {
    const init = j('program', 'init',
      '{"title":"EP","nodes":[' +
      '{"id":"p1","title":"P1","dependsOn":[]},' +
      '{"id":"p2","title":"P2","dependsOn":["p1"]}]}');
    expect(init.ok).toBe(true);
    expect(init.programId).toMatch(/^pgm_/);
    const st = j('program', 'status', `{"programId":"${init.programId}"}`);
    expect(st.title).toBe('EP');
  });

  it('12. bulk program init with tasks: node deps gate steps', () => {
    const init = j('program', 'init',
      '{"title":"BD","nodes":[' +
      '{"id":"n0","title":"N0","tasks":[' +
        '{"id":"T0","title":"Setup","steps":[' +
          '{"id":"a","title":"Init","dependsOn":[]},' +
          '{"id":"b","title":"Config","dependsOn":["a"]}]}' +
      ']},' +
      '{"id":"n1","title":"N1","dependsOn":["n0"],"tasks":[' +
        '{"id":"T1","title":"Build","steps":[' +
          '{"id":"x","title":"Code","dependsOn":[]}]}' +
      ']}]}');
    expect(init.ok).toBe(true);
    expect(init.tasks).toHaveLength(2);
    const t0 = init.tasks.find((t:any)=>t.title==='Setup');
    const t1 = init.tasks.find((t:any)=>t.title==='Build');
    // All tasks pending at init — program start activates
    expect(t0.currentSteps).toHaveLength(0);
    expect(Object.keys(t0.stepKeys)).toHaveLength(0);
    expect(t1.currentSteps).toHaveLength(0);
    // program start activates n0's tasks
    const s0 = j('program', 'start', JSON.stringify({ programId: init.programId, nodeId: init.nodes[0].nodeId }));
    expect(s0.ok).toBe(true);
    expect(s0.tasks.length).toBe(1);
    expect(s0.tasks[0].currentSteps.length).toBe(1);

    // Checkpoint chain using program start keys
    const t0a = s0.tasks[0];
    const s1 = t0a.currentSteps[0];
    const c1 = j('checkpoint', `{"taskId":"${t0a.taskId}","stepId":"${s1.stepId}","stepKey":"${t0a.stepKeys[s1.stepId]}"}`);
    expect(c1.ok).toBe(true);
    expect(c1.nextSteps.length).toBe(1);
    const ns = c1.nextSteps[0];
    const c2 = j('checkpoint', `{"taskId":"${t0a.taskId}","stepId":"${ns.stepId}","stepKey":"${c1.nextStepKeys[ns.stepId]}"}`);
    expect(c2.allStepsCompleted).toBe(true);
    expect(j('finalize', `{"taskId":"${t0a.taskId}","taskKey":"${c2.taskKey}"}`).ok).toBe(true);
  });

  it('13. program init backward compat (no tasks)', () => {
    const init = j('program', 'init', '{"title":"NT","nodes":[{"id":"a","title":"A"}]}');
    expect(init.ok).toBe(true);
    expect(init.tasks).toHaveLength(0);
  });
});
