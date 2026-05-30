// Agent Step Gate — Stop Hook (Node.js, cross-platform)
// Runs before session ends. Blocks if tasks are incomplete.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CWD = process.cwd();

function cli(args) {
  const r = spawnSync('node', [
    `${CWD}/node_modules/.bin/step-gate`, ...args
  ], { cwd: CWD, encoding: 'utf-8', timeout: 10000 });
  // Fallback: try globally installed step-gate
  if (r.status !== 0 || !r.stdout) {
    const r2 = spawnSync('npx', ['agent-step-gate', ...args],
      { cwd: CWD, encoding: 'utf-8', timeout: 15000 });
    return r2.stdout || r2.stderr || '';
  }
  return r.stdout || r.stderr || '';
}

// Fast path: state.json
let hasActive = false;
try {
  const state = JSON.parse(readFileSync(`${CWD}/data/state.json`, 'utf-8'));
  hasActive = state.hasActiveTask === true;
} catch { /* no state file */ }

if (!hasActive) {
  process.exit(0);
}

// Inspect active tasks
const out = cli(['active-task']);
try {
  const d = JSON.parse(out);
  if (!d.activeTasks || d.activeTasks.length === 0) {
    process.exit(0);
  }

  let blocked = false;
  for (const t of d.activeTasks) {
    const done = t.completedSteps || 0;
    const total = t.totalSteps || 0;
    const current = t.currentSteps || [];

    if (current.length === 0 && done === total && done > 0) {
      blocked = true;
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║  ⛔ ACTION REQUIRED: Task complete but not finalized        ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  Task:  ${t.taskId}  "${t.title}"`);
      console.log(`║  Steps: ${done}/${total} all done — waiting for finalize`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  Run this NOW:                                              ║');
      console.log(`║  step-gate finalize '{"taskId":"${t.taskId}","taskKey":"<YOUR_TASKKEY>"}'`);
      console.log('║                                                            ║');
      console.log('║  The taskKey was returned by the last checkpoint.           ║');
      console.log('║  DO NOT continue until this task is finalized.              ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    } else if (current.length > 0) {
      blocked = true;
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║  ⛔ ACTION REQUIRED: Task has unfinished steps              ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  Task:  ${t.taskId}  "${t.title}"  (${done}/${total} done)`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      for (const c of current) {
        console.log(`║  Pending: ${c.stepId} [${c.index}/${c.total}] ${c.path}`);
      }
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  Run this NOW to see what to do:                            ║');
      console.log(`║  step-gate current '{"taskId":"${t.taskId}"}'`);
      console.log('║                                                            ║');
      console.log('║  Then checkpoint each pending step.                         ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    }
  }

  if (!blocked) {
    process.exit(0);
  }
} catch {
  console.log('⚠ Step Gate: unable to check active tasks. Verify manually.');
  process.exit(0);
}

// Non-blocking: always exit 0 so the session isn't killed
process.exit(0);
