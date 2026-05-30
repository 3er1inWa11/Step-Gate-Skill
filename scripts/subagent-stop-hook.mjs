// Step Gate — SubagentStop Hook
// Fires when any Sub Agent completes. Checks if a task is ready for finalize.
import { readFileSync, existsSync } from 'node:fs';

const CWD = process.cwd();

// Quick check: is Step Gate active in this project?
if (!existsSync(`${CWD}/data/state.json`)) process.exit(0);

let state;
try { state = JSON.parse(readFileSync(`${CWD}/data/state.json`, 'utf-8')); }
catch { process.exit(0); }

if (!state.hasActiveTask) process.exit(0);

// Find all-done-not-finalized tasks
const ready = (state.activeTasks || []).filter(t =>
  t.completed === t.total && t.current.length === 0
);

if (ready.length === 0) process.exit(0);

// Print warning for Main Agent
console.log('');
console.log('═══════════════════════════════════════════');
console.log('🔒 Step Gate: Sub Agent completed, task ready for finalize');
console.log('═══════════════════════════════════════════');
for (const t of ready) {
  console.log(`  Task: ${t.taskId} "${t.title}" — ALL ${t.total}/${t.total} steps done`);
  console.log(`  → Main Agent: run step-gate finalize '{"taskId":"${t.taskId}","taskKey":"<taskKey>"}'`);
}
console.log('═══════════════════════════════════════════');
console.log('');
process.exit(0);
