// ============================================================================
// Agent Step Gate — Minimal CLI
// Does NOT start MCP Server. Directly operates on the repository.
// Usage:
//   node dist/cli.js gate_active_task
//   node dist/cli.js gate_finalize <taskId> <finalKey>
// ============================================================================

import { getActiveTasks, getTaskSteps, getTask, verifyFinalKey, updateTaskStatus, addEvent } from './storage/repository.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  if (command === 'gate_active_task') {
    const tasks = getActiveTasks();
    if (tasks.length === 0) {
      console.log(JSON.stringify({ activeTasks: [] }));
      process.exit(0);
    }
    const activeTasks = tasks.map(task => {
      const steps = getTaskSteps(task.id);
      const currentSteps = steps.filter(s => s.status === 'current').map(s => ({
        stepId: s.id,
        path: s.path,
        index: s.orderIndex,
        total: task.totalSteps,
      }));
      return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        totalSteps: task.totalSteps,
        completedSteps: steps.filter(s => s.status === 'completed').length,
        currentSteps,
      };
    });
    console.log(JSON.stringify({ activeTasks }));
    process.exit(0);
  }

  if (command === 'gate_finalize') {
    const taskId = args[1];
    const finalKey = args[2];
    if (!taskId || !finalKey) {
      console.log(JSON.stringify({ accepted: false, message: 'Usage: cli.js gate_finalize <taskId> <finalKey>' }));
      process.exit(1);
    }
    const task = getTask(taskId);
    if (!task) {
      console.log(JSON.stringify({ accepted: false, message: 'Task not found.' }));
      process.exit(1);
    }
    const isValid = verifyFinalKey(taskId, finalKey);
    if (!isValid) {
      const allSteps = getTaskSteps(taskId);
      const pendingSteps = allSteps
        .filter(s => s.status !== 'completed')
        .map(s => ({
          stepId: s.id,
          path: s.path,
          index: s.orderIndex,
          total: task.totalSteps,
        }));
      console.log(JSON.stringify({ accepted: false, message: 'Invalid final_key.', pendingSteps }));
      process.exit(1);
    }
    updateTaskStatus(taskId, 'completed');
    addEvent(taskId, null, 'task_finalized');
    console.log(JSON.stringify({ accepted: true, message: 'Task finalized.' }));
    process.exit(0);
  }

  console.log(JSON.stringify({ error: `Unknown command: ${command}` }));
  process.exit(1);
}

main();
