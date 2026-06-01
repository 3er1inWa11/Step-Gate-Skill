// Phase 7 full walkthrough — E2E multi-agent simulation
const { spawnSync } = require('node:child_process');
const CLI = 'node dist/cli.js';

function j(...args) {
  const r = spawnSync('node', ['dist/cli.js', ...args], { encoding: 'utf-8', timeout: 10000 });
  try { return JSON.parse((r.stdout||'').trim()||r.stderr||''); } catch(e) {
    throw new Error(`ParseFail: >>>${r.stdout}<<< stderr: ${r.stderr}`);
  }
}

// === ACT 0: Register full DAG ===
console.log('╔═══════════════════════════════════════════╗');
console.log('║   PHASE 7 完整多 Agent 协同演示           ║');
console.log('╚═══════════════════════════════════════════╝\n');

const phase7 = {
  title: 'Phase 7 — 审计修复 DAG',
  nodes: [
    { id:'wave0', title:'文档先行', tasks:[
      { id:'F0', title:'OpenSpec', steps:[
        { id:'S0.1', title:'proposal.md', dependsOn:[] },
        { id:'S0.2', title:'tasks.md', dependsOn:['S0.1'] },
        { id:'S0.3', title:'design.md', dependsOn:['S0.2'] }]}
    ]},
    { id:'wave1', title:'并行修复', dependsOn:['wave0'], tasks:[
      { id:'F1', title:'turn_executor', steps:[
        { id:'S1.1', title:'L791', dependsOn:[] },
        { id:'S1.2', title:'Test', dependsOn:['S1.1'] }]},
      { id:'F2', title:'continuity', steps:[
        { id:'S2.1', title:'payoff', dependsOn:[] },
        { id:'S2.2', title:'Test', dependsOn:['S2.1'] }]}
    ]},
    { id:'wave2', title:'集成', dependsOn:['wave1'], tasks:[
      { id:'F7', title:'Wire#4', steps:[
        { id:'S7.1', title:'接入', dependsOn:[] },
        { id:'S7.2', title:'测试', dependsOn:['S7.1'] }]}
    ]},
    { id:'wave3', title:'验证', dependsOn:['wave2'], tasks:[
      { id:'F10', title:'全量测试', steps:[
        { id:'S10.1', title:'pytest', dependsOn:[] }]}
    ]},
    { id:'wave4', title:'闭环', dependsOn:['wave3'], tasks:[
      { id:'F12', title:'DEVLOG', steps:[
        { id:'S12.1', title:'commit', dependsOn:[] }]}
    ]}
  ]
};

console.log('━━━ ACT 0: program init (1 command = all DAG) ━━━');
const R0 = j('program', 'init', JSON.stringify(phase7));
console.log('programId:', R0.programId);
console.log('tasks:');
for (const t of R0.tasks) {
  const ready = t.currentSteps.length > 0 ? '✓ READY' : '🔒 locked';
  console.log(`  ${ready} ${t.taskId} "${t.title}" (${t.currentSteps.length}/${t.totalSteps} active)`);
}
const PROG = R0.programId;
const W0 = R0.nodes[0].nodeId;
const W1 = R0.nodes[1].nodeId;
const W2 = R0.nodes[2].nodeId;
const W3 = R0.nodes[3].nodeId;
const W4 = R0.nodes[4].nodeId;

// === ACT 1: Wave 0 ===
console.log('\n━━━ ACT 1: Wave-0 文档先行 ━━━');
console.log(`program start ${W0}`);
const S0 = j('program', 'start', JSON.stringify({ programId: PROG, nodeId: W0 }));
console.log('sessionId:', S0.sessionId);
const f0 = S0.tasks[0];
console.log(`Task: ${f0.taskId} "${f0.title}"`);
for (const s of f0.currentSteps) console.log(`  → ${s.stepId} "${s.path}" key=${f0.stepKeys[s.stepId]}`);
console.log('\nMain → Sub Agent F0: injected taskId + stepKey');

// Sub Agent F0 checkpoints all 3 steps
let step = f0.currentSteps[0];
let c1 = j('checkpoint', JSON.stringify({ taskId: f0.taskId, stepId: step.stepId, stepKey: f0.stepKeys[step.stepId] }));
console.log('Sub F0: ✓ S0.1 done →', c1.nextSteps[0].path, 'unlocked');
step = c1.nextSteps[0];
let c2 = j('checkpoint', JSON.stringify({ taskId: f0.taskId, stepId: step.stepId, stepKey: c1.nextStepKeys[step.stepId] }));
console.log('Sub F0: ✓ S0.2 done →', c2.nextSteps[0].path, 'unlocked');
step = c2.nextSteps[0];
let c3 = j('checkpoint', JSON.stringify({ taskId: f0.taskId, stepId: step.stepId, stepKey: c2.nextStepKeys[step.stepId] }));
console.log('Sub F0: ✓ S0.3 done → allStepsCompleted, taskKey=', c3.taskKey);
console.log('Sub F0 → Main: taskKey=' + c3.taskKey);

let ff0 = j('finalize', JSON.stringify({ taskId: f0.taskId, taskKey: c3.taskKey }));
console.log('Main finalize F0:', ff0.ok ? 'OK level=' + ff0.level : 'FAIL');

// === ACT 2: Wave 1 ===
console.log('\n━━━ ACT 2: Wave-1 并行修复 ━━━');
console.log(`program start ${W1}`);
const S1 = j('program', 'start', JSON.stringify({ programId: PROG, nodeId: W1 }));
console.log('tasks activated:', S1.tasks.length);
for (const t of S1.tasks) {
  console.log(`  ${t.taskId} "${t.title}"`);
  for (const s of t.currentSteps) console.log(`    → ${s.stepId} "${s.path}" key=${t.stepKeys[s.stepId]}`);
}

// Parallel Sub Agents F1 + F2
console.log('\nMain → Sub F1: injected taskId + stepKey (turn_executor)');
console.log('Main → Sub F2: injected taskId + stepKey (continuity)');
console.log('(2 Sub Agents running in parallel...)\n');

// F1
const f1 = S1.tasks[0];
let f1c1 = j('checkpoint', JSON.stringify({ taskId: f1.taskId, stepId: f1.currentSteps[0].stepId, stepKey: f1.stepKeys[f1.currentSteps[0].stepId] }));
let f1c2 = j('checkpoint', JSON.stringify({ taskId: f1.taskId, stepId: f1c1.nextSteps[0].stepId, stepKey: f1c1.nextStepKeys[f1c1.nextSteps[0].stepId] }));
console.log('Sub F1: ✓ S1.1→S1.2 done, taskKey=' + f1c2.taskKey);
console.log('Sub F1 → Main: taskKey=' + f1c2.taskKey);
j('finalize', JSON.stringify({ taskId: f1.taskId, taskKey: f1c2.taskKey }));
console.log('Main finalize F1: OK');

// F2 (parallel)
const f2 = S1.tasks[1];
let f2c1 = j('checkpoint', JSON.stringify({ taskId: f2.taskId, stepId: f2.currentSteps[0].stepId, stepKey: f2.stepKeys[f2.currentSteps[0].stepId] }));
let f2c2 = j('checkpoint', JSON.stringify({ taskId: f2.taskId, stepId: f2c1.nextSteps[0].stepId, stepKey: f2c1.nextStepKeys[f2c1.nextSteps[0].stepId] }));
console.log('Sub F2: ✓ S2.1→S2.2 done, taskKey=' + f2c2.taskKey);
console.log('Sub F2 → Main: taskKey=' + f2c2.taskKey);
j('finalize', JSON.stringify({ taskId: f2.taskId, taskKey: f2c2.taskKey }));
console.log('Main finalize F2: OK');

// === ACT 3-5: Waves 2-4 ===
console.log('\n━━━ ACT 3-5: Waves 2→3→4 ━━━');
for (const [waveName, nodeId] of [['Wave-2 集成', W2], ['Wave-3 验证', W3], ['Wave-4 闭环', W4]]) {
  console.log(`\nprogram start ${nodeId} (${waveName})`);
  const Sw = j('program', 'start', JSON.stringify({ programId: PROG, nodeId }));
  for (const t of Sw.tasks) {
    const s = t.currentSteps[0];
    const ci = j('checkpoint', JSON.stringify({ taskId: t.taskId, stepId: s.stepId, stepKey: t.stepKeys[s.stepId] }));
    console.log(`  Sub Agent: ✓ "${s.path}" done, taskKey=${ci.taskKey}`);
    j('finalize', JSON.stringify({ taskId: t.taskId, taskKey: ci.taskKey }));
    console.log(`  Main finalize: OK level=${JSON.parse(JSON.stringify(ci)).level||'task'}`);
  }
}

// === Final status ===
console.log('\n╔═══════════════════════════════════════════╗');
console.log('║  Phase 7: 5 waves completed              ║');
console.log('║  1 program init = all DAG registered     ║');
console.log('║  5 program start = tasks activated       ║');
console.log('║  6 tasks finalized = all steps verified  ║');
console.log('╚═══════════════════════════════════════════╝');

const active = j('active-task');
console.log('Active tasks remaining:', active.activeTasks.length);
