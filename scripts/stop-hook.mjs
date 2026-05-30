// Agent Step Gate — Stop Hook (Node.js, cross-platform)
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
process.chdir(ROOT);

function cli(args) {
  const r = spawnSync('node', ['dist/cli.js', ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 10000 });
  return r.stdout || r.stderr || '';
}

// 1. Fast path: state.json
let hasActive = false;
try {
  const state = JSON.parse(readFileSync('data/state.json', 'utf-8'));
  hasActive = state.hasActiveTask === true;
} catch { /* no state file */ }

if (!hasActive) {
  // Check binding files exist
  const bindDir = `${ROOT}/.step-gate/bindings`;
  if (existsSync(bindDir)) {
    console.log('✅ Step Gate: 无活跃 task，可安全退出');
  }
  process.exit(0);
}

// 2. Inspect active tasks
console.log('');
console.log('═══════════════════════════════════════════');
console.log('🔒 Step Gate Stop Hook');
console.log('═══════════════════════════════════════════');
console.log('');

const out = cli(['active-task']);
try {
  const d = JSON.parse(out);
  if (!d.activeTasks || d.activeTasks.length === 0) {
    console.log('✅ 无活跃 task，可安全退出');
    console.log('');
    console.log('═══════════════════════════════════════════');
    process.exit(0);
  }

  let block = false;
  for (const t of d.activeTasks) {
    const done = t.completedSteps || 0;
    const total = t.totalSteps || 0;
    const current = t.currentSteps || [];

    if (current.length === 0 && done === total && done > 0) {
      console.log(`🚫 阻塞! Task ${t.taskId} "${t.title}" ${done}/${total} 步全部完成但未 Finalize!`);
      console.log(`   → node dist/cli.js finalize '{"taskId":"${t.taskId}","taskKey":"<你的taskKey>"}'`);
      console.log(`   → taskKey 在最后一步 checkpoint 的返回值中`);
      console.log('');
      block = true;
    } else if (current.length > 0) {
      console.log(`⚠️  Task ${t.taskId} "${t.title}" ${done}/${total} 步`);
      for (const c of current) {
        console.log(`   ⏳ ${c.stepId} [${c.index}/${c.total}] ${c.path}`);
      }
      console.log('');
    }
  }

  if (!block) {
    console.log('💡 继续 checkpoint 或 finalize 后即可安全退出');
  }
} catch (e) {
  console.log('⚠️  无法解析 active-task 输出，请手动检查');
  console.log(out.slice(0, 500));
}

console.log('═══════════════════════════════════════════');

if (process.env.STEP_GATE_STRICT === '1') {
  process.exit(1);
}
process.exit(0);
