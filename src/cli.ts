// ============================================================================
// Agent Step Gate — CLI (Skill-driven, no MCP dependency)
// ============================================================================
//
// Session binding (fail-closed):
//   1. --session-file .step-gate/sessions/ses_xxx.json
//   2. --binding-file .step-gate/bindings/bind_xxx.json
//   3. STEP_GATE_SESSION_FILE env var
//   4. STEP_GATE_BINDING_FILE env var
//   5. Not found → no session, exit 0 (or exit 1 if STEP_GATE_STRICT=1)
//
// Commands:
//   start-plan   '<json>'
//   checkpoint   '<json>'
//   current      '<json>'
//   finalize     '<json>'
//   cancel-task  '<json>'
//   active-task
// ============================================================================

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { flattenPlan } from './core/plan.js';
import { generateStepKey, randomCode } from './core/keys.js';
import { createSession, getCurrentSessionId, verifyRecoveryToken } from './core/session.js';
import { validateCheckpoint, advanceSteps } from './core/gate.js';
import {
  createTask, getActiveTasks, getTaskSteps, getTask,
  getCurrentSteps, getStep, verifyTaskKey, updateTaskStatus, addEvent,
  completeAndAdvance,
  verifySkipKey, recordSkipConsumed, cancelTask as repoCancelTask,
} from './storage/repository.js';
import type { GateRepository } from './core/gate.js';
import { createProgram, getProgramStatus, getReadyNodes, startProgramNode, commitProgramNode, finalizeProgram, getRebuildManifest, executeRebuild } from './core/program.js';
import { reconcile } from './core/reconcile.js';

// ---- Safe CLI helpers ----

function parseArg(jsonStr: string | undefined): any {
  if (!jsonStr) return null;
  try { return JSON.parse(jsonStr); } catch { return null; }
}

// Global error boundary
process.on('uncaughtException', (err) => {
  console.log(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', message: err.message }));
  process.exit(1);
});

// ---- State file (lightweight snapshot, read by UserPromptSubmit hook) ----

function updateStateFile() {
  try {
    const tasks = getActiveTasks().map(t => {
      const steps = getTaskSteps(t.id);
      return {
        taskId: t.id, title: t.title,
        completed: steps.filter(s => s.status === 'completed').length,
        total: t.totalSteps,
        current: steps.filter(s => s.status === 'current').map(s => s.path),
      };
    });
    mkdirSync('.step-gate', { recursive: true });
    writeFileSync('.step-gate/state.json', JSON.stringify({
      hasActiveTask: tasks.length > 0,
      activeTasks: tasks,
    }));
  } catch { /* best effort */ }
}
import type { PlanNode, TaskRow, StepRow } from './types/index.js';

// ---- Session resolution ----

interface SessionFile { session_id: string; session_secret: string; recovery_token: string; cli_instance_id: string; workspace: string; }
interface BindingFile { session_id: string; session_file: string; cli_instance_id: string; workspace: string; }

function readJSON(path: string): any | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function resolveSessionId(): { id: string } | null {
  const args = process.argv.slice(2);
  const fIdx = args.indexOf('--session-file');
  if (fIdx >= 0) { const d = readJSON(args[fIdx + 1]) as SessionFile | null; if (d?.session_id) return { id: d.session_id }; return null; }
  const bIdx = args.indexOf('--binding-file');
  if (bIdx >= 0) {
    const b = readJSON(args[bIdx + 1]) as BindingFile | null;
    if (b?.session_file) { const d = readJSON(b.session_file) as SessionFile | null; if (d?.session_id) return { id: d.session_id }; }
    return null;
  }
  const env = process.env.STEP_GATE_SESSION_FILE;
  if (env) { const d = readJSON(env) as SessionFile | null; if (d?.session_id) return { id: d.session_id }; return null; }
  const envB = process.env.STEP_GATE_BINDING_FILE;
  if (envB) {
    const b = readJSON(envB) as BindingFile | null;
    if (b?.session_file) { const d = readJSON(b.session_file) as SessionFile | null; if (d?.session_id) return { id: d.session_id }; }
    return null;
  }
  // Fallback: auto-discover from binding files (same as ensureSession)
  try {
    const bindDir = '.step-gate/bindings';
    const files = readdirSync(bindDir).filter(f => f.endsWith('.json'));
    let best = '', bestMtime = 0;
    for (const f of files) {
      const m = statSync(`${bindDir}/${f}`).mtimeMs;
      if (m > bestMtime) { bestMtime = m; best = f; }
    }
    if (best) {
      const bind = JSON.parse(readFileSync(`${bindDir}/${best}`, 'utf-8'));
      if (bind.session_file) {
        const sf = JSON.parse(readFileSync(bind.session_file, 'utf-8'));
        if (sf.session_id) return { id: sf.session_id };
      }
    }
  } catch { /* no binding dir yet */ }

  // Last-resort: in-process session (MCP mode)
  const sid = getCurrentSessionId();
  if (sid) return { id: sid };
  return null;
}

function failNoSession(): never {
  if (process.env.STEP_GATE_STRICT === '1') {
    console.log(JSON.stringify({ ok: false, error: 'no session bound (strict mode)' }));
    process.exit(1);
  }
  // Legacy compat: return empty activeTasks for Stop Hook
  console.log(JSON.stringify({ activeTasks: [] }));
  process.exit(0);
}

// ---- Lazy session (created on first start-plan) ----

let processSession: { sessionId: string; sessionSecret: string; recoveryToken: string; cliInstanceId: string } | null = null;

function ensureSession() {
  if (processSession) return processSession;

  // Reuse the most recent session (e.g. from program start)
  try {
    const bindDir = '.step-gate/bindings';
    const files = readdirSync(bindDir).filter(f => f.endsWith('.json'));
    if (files.length > 0) {
      let best = '', bestMtime = 0;
      for (const f of files) {
        const m = statSync(`${bindDir}/${f}`).mtimeMs;
        if (m > bestMtime) { bestMtime = m; best = f; }
      }
      if (best) {
        const bind = JSON.parse(readFileSync(`${bindDir}/${best}`, 'utf-8'));
        if (bind.session_file) {
          const sf = JSON.parse(readFileSync(bind.session_file, 'utf-8'));
          processSession = { sessionId: sf.session_id, sessionSecret: sf.session_secret, recoveryToken: sf.recovery_token, cliInstanceId: sf.cli_instance_id };
          return processSession;
        }
      }
    }
  } catch { /* no binding dir yet */ }

  const s = createSession(process.cwd());
  processSession = { sessionId: s.sessionId, sessionSecret: s.sessionSecret, recoveryToken: s.recoveryToken, cliInstanceId: s.cliInstanceId };
  return processSession;
}

// ---- Command handlers ----

function cmdStartPlan() {
  const input = parseArg(process.argv[3]);
  if (!input?.title || !input?.steps?.length) {
    console.log(JSON.stringify({ ok: false, error: 'PLAN_SCHEMA_INVALID', message: 'title and steps required' }));
    process.exit(1);
  }

  const sess = ensureSession();
  const taskId = `tsk_${randomCode(6)}`;
  const leafSteps = flattenPlan(input.steps as PlanNode[], taskId);

  // Collect skip proofs from original nodes
  const skipProofs = new Map<string, { taskId: string; key: string }>();
  (input.steps as PlanNode[]).forEach(n => {
    if (n.skipKey && n.skipTaskId && n.id) {
      skipProofs.set(n.id, { taskId: n.skipTaskId, key: n.skipKey });
    }
  });

  // Verify skip proofs (old key must match stored hash) and record consumption
  for (const [nodeId, proof] of skipProofs) {
    const oldStepId = `${proof.taskId}_${nodeId}`;
    if (!verifySkipKey(proof.taskId, oldStepId, proof.key)) {
      console.log(JSON.stringify({ ok: false, error: 'SKIP_VERIFY_FAILED', message: `Cannot skip '${nodeId}': key verification failed or already consumed. Old task: ${proof.taskId}` }));
      process.exit(1);
    }
    recordSkipConsumed(proof.taskId, oldStepId);
  }

  const stepKeys: Record<string, string> = {};
  const now = new Date().toISOString();
  const skipNodeIds = new Set(skipProofs.keys());

  // Mark verified-skipped steps as completed
  const skippedLeafIds = new Set<string>();
  const ts = now;

  leafSteps.forEach(ls => {
    const nodeId = ls.id.substring(taskId.length + 1);
    if (skipNodeIds.has(nodeId)) {
      ls.status = 'skipped';
      ls.completedAt = ts;
      skippedLeafIds.add(ls.id);
    }
  });

  // Activate steps whose dependencies are all satisfied (including skipped ones)
  const initialCurrent = leafSteps.filter(s => {
    if (s.status === 'completed' || s.status === 'skipped') return false;
    return s.dependsOn.every(depId => leafSteps.some(x => x.id === depId && (x.status === 'completed' || x.status === 'skipped')));
  });

  const task: TaskRow = {
    id: taskId, title: input.title, status: 'active', currentIndex: 1,
    totalSteps: leafSteps.length, finalKeyHash: null,
    dependsOn: [], programId: null, programNodeId: null, sessionId: sess.sessionId,
    createdAt: now, updatedAt: now,
  };

  const steps: StepRow[] = leafSteps.map(ls => {
    if (skippedLeafIds.has(ls.id)) {
      return { id: ls.id, taskId: ls.taskId, parentPath: ls.parentPath, title: ls.title, path: ls.path, orderIndex: ls.orderIndex, dependsOn: ls.dependsOn, status: 'skipped' as const, stepKeyHash: null, currentKey: null, completedAt: ts, createdAt: ls.createdAt };
    }
    if (initialCurrent.some(cs => cs.id === ls.id)) {
      const { plaintext, hash } = generateStepKey();
      stepKeys[ls.id] = plaintext;
      return { id: ls.id, taskId: ls.taskId, parentPath: ls.parentPath, title: ls.title, path: ls.path, orderIndex: ls.orderIndex, dependsOn: ls.dependsOn, status: 'current' as const, stepKeyHash: hash, currentKey: plaintext, completedAt: null, createdAt: ls.createdAt };
    }
    return { id: ls.id, taskId: ls.taskId, parentPath: ls.parentPath, title: ls.title, path: ls.path, orderIndex: ls.orderIndex, dependsOn: ls.dependsOn, status: 'pending' as const, stepKeyHash: null, currentKey: null, completedAt: null, createdAt: ls.createdAt };
  });

  createTask(task, steps);
  updateStateFile();

  console.log(JSON.stringify({
    ok: true,
    taskId,
    session: { sessionId: sess.sessionId, sessionSecret: sess.sessionSecret, recoveryToken: sess.recoveryToken, cliInstanceId: sess.cliInstanceId },
    totalSteps: leafSteps.length,
    currentSteps: initialCurrent.map(s => ({ stepId: s.id, path: s.path, index: s.orderIndex, total: leafSteps.length })),
    stepKeys,
  }));
}

function cmdCheckpoint() {
  const input = parseArg(process.argv[3]);
  if (!input?.taskId || !input?.stepId || !input?.stepKey) {
    console.log(JSON.stringify({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'taskId, stepId, stepKey required',
      fix: 'node dist/cli.js checkpoint \'{"taskId":"tsk_XXX","stepId":"tsk_XXX_yy","stepKey":"A1B2C3"}\'',
    }));
    process.exit(1);
  }

  const repo: GateRepository = { getTask, getCurrentSteps, getTaskSteps, getStep, completeAndAdvance, updateTaskStatus, verifyTaskKey };

  let task;
  let completedPath = '';
  try {
    const r = validateCheckpoint(repo, input.taskId, input.stepId, input.stepKey);
    task = r.task;
    completedPath = r.currentStep.path;
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string; context?: { stepId: string; path: string; index: number; total: number } };
    const current = err.context;
    const fixCmd = current
      ? `node dist/cli.js checkpoint '{"taskId":"${input.taskId}","stepId":"${current.stepId}","stepKey":"<YOUR_STEP_KEY>"}'`
      : `node dist/cli.js current '{"taskId":"${input.taskId}"}'  # check what step is current`;
    console.log(JSON.stringify({
      ok: false,
      error: err.code ?? 'CHECKPOINT_FAILED',
      message: err.message,
      fix: fixCmd,
      currentStep: err.context ? { stepId: err.context.stepId, path: err.context.path, index: err.context.index, total: err.context.total } : undefined,
    }));
    process.exit(1);
  }

  const next = advanceSteps(repo, task, input.stepId);
  updateStateFile();
  console.log(JSON.stringify({
    ok: true,
    completedStep: { stepId: input.stepId, path: completedPath },
    nextSteps: next.nextSteps,
    nextStepKeys: next.nextStepKeys,
    allStepsCompleted: next.allStepsCompleted,
    taskKey: next.taskKey,
  }));
}

function cmdCurrent() {
  const input = parseArg(process.argv[3]);
  if (!input?.taskId) {
    console.log(JSON.stringify({ ok: false, error: 'INVALID_INPUT' }));
    process.exit(1);
  }
  const task = getTask(input.taskId);
  if (!task) {
    console.log(JSON.stringify({ taskId: input.taskId, status: 'not_found', currentSteps: [] }));
    process.exit(0);
  }
  const steps = getCurrentSteps(input.taskId);
  console.log(JSON.stringify({
    taskId: input.taskId,
    status: task.status,
    totalSteps: task.totalSteps,
    completedSteps: getTaskSteps(input.taskId).filter(s => s.status === 'completed').length,
    currentSteps: steps.map(s => ({
      stepId: s.id, path: s.path, index: s.orderIndex, total: task.totalSteps,
      stepKey: s.currentKey ?? undefined,
    })),
  }));
}

function cmdFinalize() {
  const input = parseArg(process.argv[3]);
  if (!input?.taskId || !input?.taskKey) {
    console.log(JSON.stringify({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'taskId and taskKey are required',
      fix: 'node dist/cli.js finalize \'{"taskId":"tsk_XXX","taskKey":"YOUR_TASKKEY"}\'\n  taskKey comes from the LAST checkpoint response (allStepsCompleted: true)',
    }));
    process.exit(1);
  }
  const task = getTask(input.taskId);
  if (!task) { console.log(JSON.stringify({
    ok: false, error: 'TASK_NOT_FOUND', message: 'Task not found',
    fix: 'Check taskId with: node dist/cli.js active-task',
  })); process.exit(1); }
  if (task.status === 'completed') { console.log(JSON.stringify({ ok: true, status: 'completed', level: 'task', message: 'Already finalized' })); process.exit(0); }
  if (task.status === 'cancelled') { console.log(JSON.stringify({
    ok: false, error: 'TASK_CANCELLED', message: 'Task was cancelled',
    fix: 'Create a new task with: node dist/cli.js start-plan \'{"title":"...","steps":[...]}\'',
  })); process.exit(1); }

  if (!verifyTaskKey(input.taskId, input.taskKey)) {
    const allSteps = getTaskSteps(input.taskId);
    const pending = allSteps.filter(s => s.status !== 'completed' && s.status !== 'skipped');
    const current = pending.filter(s => s.status === 'current');
    console.log(JSON.stringify({
      ok: false,
      status: 'active',
      level: 'task',
      message: 'Steps not checkpointed. Complete all steps before finalizing.',
      pendingSteps: pending.map(s => ({ stepId: s.id, path: s.path, index: s.orderIndex, total: task.totalSteps })),
      fix: current.length > 0
        ? `node dist/cli.js checkpoint '{"taskId":"${input.taskId}","stepId":"${current[0].id}","stepKey":"<YOUR_STEP_KEY>"}'`
        : `node dist/cli.js current '{"taskId":"${input.taskId}"}'  # find current step`,
    }));
    process.exit(1);
  }

  // Level 1: Finalize task
  updateTaskStatus(input.taskId, 'completed');
  addEvent(input.taskId, null, 'task_finalized');

  const result: any = {
    ok: true,
    level: 'task',
    taskId: input.taskId,
    taskStatus: 'completed',
    message: 'Task finalized.',
  };

  // Level 2: Auto-propagate → check if node is complete
  if (task.sessionId) {
    const commitResult = commitProgramNode(task.sessionId);
    if (commitResult) {
      result.node = {
        nodeId: commitResult.nodeId,
        programId: commitResult.programId,
        status: 'completed',
        nodeKey: commitResult.nodeKey,
      };
      result.level = 'node';
      result.message = 'Task finalized. Node auto-completed (all tasks done).';

      // Level 3: Auto-propagate → check if program is complete
      if (commitResult.allDone) {
        result.program = { programId: commitResult.programId, status: 'completed' };
        result.level = 'program';
        result.message = 'Task finalized → Node completed → Program completed.';
      }
    }
  }

  updateStateFile();
  console.log(JSON.stringify(result));
}

function cmdReconcile() {
  const input = parseArg(process.argv[3]) ?? {};
  const result = reconcile(input.programId);
  console.log(JSON.stringify(result));
}

function cmdProgram() {
  const sub = process.argv[3];
  const jsonArg = process.argv[4];

  if (sub === 'init') {
    const input = parseArg(jsonArg) ?? {};
    if (!input?.title || !input?.nodes?.length) {
      console.log(JSON.stringify({ ok: false, error: 'title and nodes[] required' }));
      process.exit(1);
    }
    const prog = createProgram(input.title, input.nodes);
    console.log(JSON.stringify({ ok: true, ...prog }));
    return;
  }

  if (sub === 'status') {
    const progId = jsonArg ? (parseArg(jsonArg) ?? {}).programId : process.argv[5];
    const prog = getProgramStatus(progId);
    if (!prog) { console.log(JSON.stringify({ ok: false, error: 'Program not found' })); process.exit(1); }
    console.log(JSON.stringify({ ok: true, ...prog }));
    return;
  }

  if (sub === 'ready') {
    const progId = jsonArg ? (parseArg(jsonArg) ?? {}).programId : process.argv[5];
    const nodes = getReadyNodes(progId);
    console.log(JSON.stringify({ ok: true, readyNodes: nodes }));
    return;
  }

  if (sub === 'start') {
    const input = parseArg(jsonArg) ?? {};
    if (!input?.programId || !input?.nodeId) {
      console.log(JSON.stringify({ ok: false, error: 'programId and nodeId required' }));
      process.exit(1);
    }
    const s = ensureSession();
    const result = startProgramNode(input.programId, input.nodeId, s.sessionId);
    if (!result.ok) {
      console.log(JSON.stringify({
        ok: false,
        error: 'NODE_NOT_READY',
        message: result._error || 'Node not in pending state or dependencies unsatisfied',
        fix: 'Check with: node dist/cli.js program status \'{"programId":"' + input.programId + '"}\'',
      }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, nodeId: input.nodeId, sessionId: result.sessionId, tasks: result.tasks }));
    return;
  }

  if (sub === 'rebuild') {
    const input = parseArg(jsonArg) ?? {};
    if (!input?.programId) {
      console.log(JSON.stringify({ ok: false, error: 'programId required' }));
      process.exit(1);
    }
    const nodeId = input.nodeId as string | undefined;
    const confirm = process.argv.includes('--confirm');

    if (!confirm) {
      // Dry run: show manifest
      const manifest = getRebuildManifest(input.programId, nodeId);
      if (!manifest) { console.log(JSON.stringify({ ok: false, error: 'Program not found' })); process.exit(1); }
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        scope: manifest.scope,
        programTitle: manifest.programTitle,
        completedSteps: manifest.completedSteps,
        willLosePending: manifest.pendingSteps,
        activeTaskCount: manifest.activeTaskCount,
        completedTaskCount: manifest.completedTaskCount,
        action: 'Review the manifest above. To proceed, re-run with --confirm.',
      }));
      return;
    }

    // Execute rebuild
    const result = executeRebuild(input.programId, nodeId);
    console.log(JSON.stringify({
      ok: true,
      confirmed: true,
      cancelledTasks: result.cancelled,
      resetNodes: result.resetNodes,
      message: nodeId
        ? `Node ${nodeId} reset to pending. ${result.cancelled} task(s) cancelled.`
        : `Program rebuilt. ${result.resetNodes.length} node(s) reset, ${result.cancelled} task(s) cancelled.`,
    }));
    return;
  }

  if (sub === 'finalize') {
    const progId = jsonArg ? (parseArg(jsonArg) ?? {}).programId : process.argv[5];
    const result = finalizeProgram(progId);
    console.log(JSON.stringify(result));
    return;
  }

  console.log(JSON.stringify({ error: `Unknown program sub-command: ${sub}` }));
  process.exit(1);
}

function cmdCancelTask() {
  const input = parseArg(process.argv[3]);
  if (!input?.taskId) { console.log(JSON.stringify({ ok: false, error: 'INVALID_INPUT' })); process.exit(1); }

  const adminFlag = process.argv.includes('--admin');
  if (adminFlag) {
    // Admin override: verify recoveryToken to cancel any session's task
    const tokenIdx = process.argv.indexOf('--recovery-token');
    const token = tokenIdx >= 0 ? process.argv[tokenIdx + 1] : null;
    if (!token) { console.log(JSON.stringify({ ok: false, error: '--recovery-token required with --admin' })); process.exit(1); }
    const task = getTask(input.taskId);
    if (!task) { console.log(JSON.stringify({ ok: false, message: 'Task not found' })); process.exit(1); }
    if (!task.sessionId || !verifyRecoveryToken(task.sessionId, token)) {
      console.log(JSON.stringify({ ok: false, error: 'INVALID_RECOVERY_TOKEN', message: 'Recovery token verification failed' }));
      process.exit(1);
    }
    updateTaskStatus(input.taskId, 'cancelled');
    addEvent(input.taskId, null, 'task_cancelled');
    updateStateFile();
    console.log(JSON.stringify({ ok: true, message: 'Task cancelled (admin).' }));
    return;
  }

  const sess = resolveSessionId();
  if (!sess) {
    console.log(JSON.stringify({ ok: false, error: 'NO_SESSION', message: 'No session bound. Use --session-file or --admin --recovery-token.' }));
    process.exit(1);
  }
  try {
    repoCancelTask(input.taskId, sess.id);
    updateStateFile();
    console.log(JSON.stringify({ ok: true, message: 'Task cancelled.' }));
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    console.log(JSON.stringify({ ok: false, error: err.code ?? 'CANCEL_FAILED', message: err.message }));
    process.exit(1);
  }
}

function cmdActiveTask() {
  // --mine flag: filter to current session only
  const mineFlag = process.argv.includes('--mine');

  if (mineFlag) {
    const sess = resolveSessionId();
    if (!sess) {
      console.log(JSON.stringify({ activeTasks: [], warning: 'No session bound — use --all to see cross-session tasks or bind a session first.' }));
      process.exit(0);
    }
    const tasks = getActiveTasks(sess.id);
    if (tasks.length === 0) { console.log(JSON.stringify({ activeTasks: [] })); process.exit(0); }
    console.log(JSON.stringify({
      activeTasks: tasks.map(t => {
        const steps = getTaskSteps(t.id);
        return {
          taskId: t.id, title: t.title, status: t.status, totalSteps: t.totalSteps,
          completedSteps: steps.filter(s => s.status === 'completed').length,
          currentSteps: steps.filter(s => s.status === 'current').map(s => ({ stepId: s.id, path: s.path, index: s.orderIndex, total: t.totalSteps })),
        };
      }),
    }));
    process.exit(0);
  }

  // Default: cross-session (all active tasks, no session filter)
  const tasks = getActiveTasks();
  if (tasks.length === 0) { console.log(JSON.stringify({ activeTasks: [] })); process.exit(0); }
  console.log(JSON.stringify({
    activeTasks: tasks.map(t => {
      const steps = getTaskSteps(t.id);
      return {
        taskId: t.id, title: t.title, status: t.status, sessionId: t.sessionId, totalSteps: t.totalSteps,
        completedSteps: steps.filter(s => s.status === 'completed').length,
        currentSteps: steps.filter(s => s.status === 'current').map(s => ({ stepId: s.id, path: s.path, index: s.orderIndex, total: t.totalSteps })),
      };
    }),
  }));
}

// ---- Help ----

function cmdHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  StepGate CLI — Agent External Execution Ledger              ║
╚══════════════════════════════════════════════════════════════╝

Usage: node dist/cli.js <command> '<json>'

Task Commands:
  start-plan   Create a task with steps
  checkpoint   Complete a step with its key
  current      Read task progress (never returns keys)
  finalize     Close a completed task with taskKey
  cancel-task  Cancel a task (session-gated)
  active-task  List all active tasks (cross-session)

Program Commands:
  program init    Register a full Program→Node→Task→Step DAG
  program start   Activate a node's tasks + get stepKeys
  program status  Read program progress
  program rebuild Dry-run or execute rebuild (needs --confirm)
  program ready   List ready nodes

Diagnostics:
  reconcile  Full DB health check

Examples:
  # Simple task
  node dist/cli.js start-plan '{"title":"Refactor","steps":[{"id":"a","title":"Extract","dependsOn":[]}]}'

  # Checkpoint a step
  node dist/cli.js checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_a","stepKey":"A1B2C3"}'

  # Read progress (no keys returned!)
  node dist/cli.js current '{"taskId":"tsk_XXX"}'

  # Close completed task
  node dist/cli.js finalize '{"taskId":"tsk_XXX","taskKey":"D4E5F6"}'

  # Multi-wave program
  node dist/cli.js program init '{"title":"Phase 7","nodes":[...]}'
  node dist/cli.js program start '{"programId":"pgm_XXX","nodeId":"pgm_XXX_wave1"}'

All output is JSON. Non-zero exit = error.
`);
  process.exit(0);
}

// ---- Main dispatch ----

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  cmdHelp();
}

const cmds: Record<string, () => void> = {
  'start-plan': cmdStartPlan,
  'checkpoint': cmdCheckpoint,
  'current': cmdCurrent,
  'finalize': cmdFinalize,
  'cancel-task': cmdCancelTask,
  'active-task': cmdActiveTask,
  'program': cmdProgram,
  'reconcile': cmdReconcile,
};

const cmd = cmds[args[0]];
if (cmd) { cmd(); } else {
  console.log(JSON.stringify({
    error: 'UNKNOWN_COMMAND',
    message: `Unknown command: ${args[0]}`,
    fix: 'Run: node dist/cli.js --help',
    availableCommands: Object.keys(cmds),
  }));
  process.exit(1);
}
