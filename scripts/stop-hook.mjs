// Agent Step Gate — Stop Hook (cross-platform)
// Runs from the current working directory (the user's project).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function cli(args) {
  const r = spawnSync('step-gate', args, { encoding: 'utf-8', timeout: 10000 });
  if (r.error) {
    // step-gate not in PATH — try npm global location
    const r2 = spawnSync('npx', ['agent-step-gate', ...args], { encoding: 'utf-8', timeout: 15000 });
    return r2.stdout || r2.stderr || '';
  }
  return r.stdout || r.stderr || '';
}

// Fast path: state.json
let hasActive = false;
try {
  const state = JSON.parse(readFileSync('data/state.json', 'utf-8'));
  hasActive = state.hasActiveTask === true;
} catch { /* no state file */ }

if (!hasActive) {
  process.exit(0);
}

// Inspect active tasks
const out = cli(['active-task']);
let data;
try { data = JSON.parse(out); } catch { process.exit(0); }

if (!data.activeTasks || data.activeTasks.length === 0) {
  process.exit(0);
}

let block = false;
let hasIncomplete = false;

for (const t of data.activeTasks) {
  const done = t.completedSteps || 0;
  const total = t.totalSteps || 0;
  const current = t.currentSteps || [];

  if (current.length === 0 && done === total && done > 0) {
    // All steps done but not finalized — BLOCK
    if (!block) {
      console.log('');
      console.log('══════════════════════════════════════════════');
      console.log('🔒 STEP GATE: TASK READY FOR FINALIZE');
      console.log('══════════════════════════════════════════════');
      console.log('');
    }
    console.log(`  Task ${t.taskId} "${t.title}" — ${done}/${total} steps DONE`);
    console.log(`  Copy and run:`);
    console.log(`    step-gate finalize '{"taskId":"${t.taskId}","taskKey":"<PASTE-YOUR-TASKKEY>"}'`);
    console.log('');
    console.log('  (taskKey was returned by the last checkpoint. Check your terminal scrollback.)');
    console.log('');
    block = true;
  } else if (current.length > 0) {
    if (!hasIncomplete) {
      console.log('');
      console.log('══════════════════════════════════════════════');
      console.log('⚠️  STEP GATE: INCOMPLETE TASKS');
      console.log('══════════════════════════════════════════════');
      console.log('');
    }
    console.log(`  Task ${t.taskId} "${t.title}" — ${done}/${total} steps`);
    for (const c of current) {
      console.log(`    ⏳ ${c.stepId} [${c.index}/${c.total}] ${c.path}`);
    }
    console.log(`  Copy and run for each current step:`);
    console.log(`    step-gate checkpoint '{"taskId":"${t.taskId}","stepId":"<stepId>","stepKey":"<stepKey>"}'`);
    console.log('');
    hasIncomplete = true;
  }
}

if (hasIncomplete) {
  console.log('  Continue checkpointing the remaining steps, then finalize.');
  console.log('');
}

if (block) {
  console.log('══════════════════════════════════════════════');
  console.log('  FINALIZE THE TASK BEFORE EXITING.');
  console.log('══════════════════════════════════════════════');
  console.log('');
}

// Still exit 0 (non-blocking) but the message is clear.
// Set STEP_GATE_STRICT=1 for hard block.
process.exit(0);
