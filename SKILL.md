---
name: Step Gate
description: >
  Use this skill whenever working on multi-step tasks, large refactors, cross-session
  development, or multi-agent orchestration — any situation where skipping a planned step
  would be costly. This skill enforces an external cryptographic ledger: every planned step
  must be checkpointed with a valid key before the task can be finalized. Triggers on
  phrases like "multi-step plan", "refactor in phases", "orchestrate agents", "long task",
  "don't skip steps", "checkpoint my work", "gate my steps", or any mention of Step Gate.
---

# Step Gate — External Execution Ledger

An external cryptographic gate for agent task execution. It does not control *how* you
work — it only verifies *that you did* what you planned. Think of it as a
proof-of-work chain for agent steps: every completed step produces a cryptographic key,
and you cannot finalize a task without the final chain key.

## Hierarchy — Step is the ATOM (mandatory)

Step Gate has **exactly four levels**. Step is the smallest unit — no matter what
level you start from, you MUST design down to Step.

```
                         ┌──────────────────────────────────┐
  Program    (可选)       │ 跨会话的完整项目                  │
    │                     │ 例: "后端架构重构"                │
    │                     │ 包含多个 Node                     │
    │                     └──────────────────────────────────┘
    ▼
                         ┌──────────────────────────────────┐
  Node       (可选)       │ 一个执行阶段 / 一个波次            │
    │                     │ 例: "Phase A: 数据库接入"         │
    │                     │ Node 之间有依赖关系               │
    │                     │ 一个 Node 包含多个 Task           │
    │                     └──────────────────────────────────┘
    ▼
                         ┌──────────────────────────────────┐
  Task       (必选)       │ 一次 Agent 交互 = 一个 Task       │
    │                     │ 例: "OpenSpec 文档"              │
    │                     │ 一个 Task 包含 1~N 个 Step       │
    │                     └──────────────────────────────────┘
    ▼
                         ┌──────────────────────────────────┐
  Step       (必选)       │ ⚠ 最小执行原子，不可再拆分       │
                          │ 例: "写 proposal.md"             │
                          │ 一个 Step = 一个动作 + 一条密钥   │
                          │ 完成 ↔ 未完成 二元判断           │
                          └──────────────────────────────────┘
```

**无论从哪个层级起步，最终必须落到 Step 层级。** 哪怕只有一个 Step，也必须用 Task 包住它。

```
错误:  "我来重构一下 auth 模块"          ← 没有 Step，无法 checkpoint
正确:  Task "重构 auth" → Step "提取 middleware" → Step "JWT 验证" → Step "测试"
```

**Step 粒度规则：每一步必须能回答"完成了吗？"**

| 太粗 (不能用) | 刚好 (可以用) |
|--------------|-------------|
| "重构 auth 模块" | "提取 auth middleware 到 src/middleware/auth.ts" |
| "写测试" | "为 auth.ts 写 3 个单元测试" |
| "更新文档" | "更新 README 的 Auth 章节" |
| "修 bug" | "修复 login 页面的空指针异常" |

如果一个 Step 描述包含"和"、"以及"、"同时"——拆成多个 Step。

## Core rule — single Task workflow

For simple work that fits in one interaction:

1. **Plan** — break the work into concrete Steps with DAG dependencies
2. **Show the DAG to the user** — present the full step plan before calling `start-plan`
3. **Get confirmation** — user must explicitly approve the plan
4. **Register** — call `start-plan` to lock the plan in the external ledger
5. **Execute** — checkpoint each Step as you complete it
6. **Finalize** — submit the taskKey to close the Task

```
Plan → Show DAG → User confirms → start-plan → checkpoint × N → finalize(taskKey) → done
```

## Core rule — multi-wave Program workflow

For work spanning multiple nodes/phases (cross-session or multi-agent):

```
program init → show DAG → user confirms
  ↓
  ┌─────────────────────────────────────────────────────┐
  │  For EACH Wave (Node):                              │
  │    program start <node>  →  activates tasks         │
  │    ↓                                                │
  │    Main Agent dispatches Sub Agents                 │
  │    (inject taskId + stepKeys per Weaver protocol)   │
  │    ↓                                                │
  │    Sub Agent(s) → checkpoint × N → taskKey          │
  │    ↓                                                │
  │    Main Agent → finalize(taskId, taskKey)            │
  │    ↓                                                │
  │    When all tasks in node are done → node complete   │
  │    ↓                                                │
  │    User manually starts next wave:                  │
  │    program start <next-node>                        │
  └─────────────────────────────────────────────────────┘
```

**Each wave requires an explicit `program start`.** Waves do NOT auto-unlock — this is
intentional. A single interaction should not cascade through all waves automatically
(the Stop Hook would never let the session end).

## Proactive checkpointing

After completing each step, immediately call `checkpoint` with the step's key. Do NOT
batch checkpoints, do NOT wait for the Hook to remind you. The Hook is a safety net,
not your workflow. If you see `ACTION REQUIRED`, stop everything and resolve it.

## Large DAG registration — write JSON to file first

For programs with many Nodes/Tasks/Steps (e.g. 29 Tasks, 145 Steps), the Bash argument
limit may truncate the JSON. **Always write large JSON to a temp file first:**

```bash
# Write the program DAG to a file
cat > /tmp/dag.json << 'EOF'
{"title":"...","nodes":[...]}
EOF

# Register from file
node dist/cli.js program init "$(cat /tmp/dag.json)"
```

Never inline a JSON exceeding ~10 lines in a Bash command. Write to file, then `cat`.

## Weaver protocol — MANDATORY for Sub Agent dispatch

**When you spawn a Sub Agent, you MUST copy the dispatch template below into the
Sub Agent's prompt.** The Sub Agent cannot discover its task or keys on its own.

```
⛔ READ THIS FIRST — You are a Sub Agent under Step Gate.

Workspace: <PROJECT_ROOT>
CLI: node dist/cli.js

Your task was pre-registered with Step Gate. You do NOT create tasks.

ASSIGNED STEPS:
  Task ID: <taskId>
  Step: <stepId> — "<description>" — Key: <stepKey>

RULES:
1. cd <PROJECT_ROOT> before any step-gate command
2. Complete your step, then immediately checkpoint:
   node dist/cli.js checkpoint '{"taskId":"<taskId>","stepId":"<stepId>","stepKey":"<stepKey>"}'
3. The checkpoint response gives nextSteps + nextStepKeys if more steps unlock
4. When checkpoint returns allStepsCompleted=true + taskKey, STOP and report the taskKey
5. Use node dist/cli.js current '{"taskId":"<taskId>"}' to check progress
6. NEVER call finalize — that is the Main Agent's job
7. NEVER call start-plan, cancel-task, or program commands
8. Keys appear ONCE. If you lose a key, report to Main Agent immediately.

When ALL steps done: report taskId + taskKey + summary back to Main Agent.
```

**Failure to include this template in Sub Agent prompts is the #1 cause of
Sub Agents not checkpointing.** Always include the full template.

## CLI reference — EVERY command with exact input/output

Each command takes **exactly one JSON string argument** after the command name.
All output is JSON to stdout. Exit code 0 = success, non-zero = error.

### start-plan — Create a Task with Steps

```
IN:  start-plan '{"title":"任务名","steps":[{"id":"s1","title":"步骤1","dependsOn":[]}]}'

step fields:
  id        — string, optional (auto-generated if omitted)
  title     — string, REQUIRED
  dependsOn — string[], optional ([]=immediate, omit=serial, ["a","b"]=merge)
  children  — PlanNode[], optional (nested sub-steps)
  skipKey   — string, optional (old key for skip on rebuild)
  skipTaskId— string, optional (old taskId for skip)

OUT: {
  ok: true,
  taskId: "tsk_A1B2C3",
  session: { sessionId, sessionSecret, recoveryToken, cliInstanceId },
  totalSteps: 3,
  currentSteps: [ { stepId: "tsk_A1B2C3_s1", path: "步骤1", index: 1, total: 3 } ],
  stepKeys: { "tsk_A1B2C3_s1": "X9K2WQ" }
}
```

### checkpoint — Complete a step, unlock downstream

```
IN:  checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_yy","stepKey":"X9K2WQ"}'

OUT (more steps unlocked): {
  ok: true,
  completedStep: { stepId: "tsk_XXX_yy", path: "步骤1" },
  nextSteps: [ { stepId: "tsk_XXX_zz", path: "步骤2", index: 2, total: 3 } ],
  nextStepKeys: { "tsk_XXX_zz": "A1B2C3" }
}

OUT (final step — all done): {
  ok: true,
  completedStep: { stepId: "tsk_XXX_zz", path: "最后一步" },
  allStepsCompleted: true,
  taskKey: "D4E5F6"     ← SAVE THIS. Report to Main Agent.
}

OUT (empty — parallel branch waiting): {
  ok: true,
  completedStep: { stepId: "...", path: "..." }
  // no nextSteps — other parallel branch still running
}

OUT (error): {
  ok: false, error: "INVALID_STEP_KEY", message: "...",
  currentStep: { stepId, path, index, total },
  fix: "node dist/cli.js checkpoint '{\"taskId\":\"...\",...}'"
}
```

### current — Read progress (always returns current stepKey)

```
IN:  current '{"taskId":"tsk_XXX"}'

OUT: {
  taskId: "tsk_XXX",
  status: "active",
  totalSteps: 3,
  completedSteps: 1,
  currentSteps: [
    { stepId: "tsk_XXX_s2", path: "步骤2", index: 2, total: 3,
      stepKey: "A1B2C3" }   ← current step's plaintext key, always included
  ]
}

OUT (not found): { taskId: "...", status: "not_found", currentSteps: [] }
```

### finalize — Close a completed task

```
IN:  finalize '{"taskId":"tsk_XXX","taskKey":"D4E5F6"}'

OUT (success): {
  ok: true, level: "task", taskId: "tsk_XXX", taskStatus: "completed"
}
// level may be "task" | "node" | "program" — auto-propagates upward

OUT (rejected — steps not done): {
  ok: false, status: "active", level: "task",
  message: "Steps not checkpointed",
  pendingSteps: [ { stepId, path, index, total } ],
  fix: "node dist/cli.js checkpoint '{\"taskId\":\"...\",...}'"
}
```

### active-task — List active tasks (cross-session by default)

```
IN:  active-task

OUT: {
  activeTasks: [
    { taskId: "tsk_XXX", title: "...", status: "active",
      sessionId: "ses_XXX", totalSteps: 3,
      completedSteps: 1,
      currentSteps: [ { stepId, path, index, total } ]
    }
  ]
}
```

### cancel-task — Cancel a task

```
IN:  cancel-task '{"taskId":"tsk_XXX"}'

OUT: { ok: true, message: "Task cancelled." }
// Session-gated. Cross-session requires --admin --recovery-token <token>
```

### program init — Register full Program→Node→Task→Step DAG

```
IN:  program init '{"title":"项目名","nodes":[
  {"id":"wave0","title":"阶段0","tasks":[
    {"id":"T0","title":"任务0","steps":[
      {"id":"s1","title":"步骤1","dependsOn":[]}
    ]}
  ]},
  {"id":"wave1","title":"阶段1","dependsOn":["wave0"],"tasks":[...]}
]}'

node fields:
  id         — string, optional (prefixed with programId)
  title      — string, REQUIRED
  dependsOn  — string[], optional (node-level deps)
  tasks      — NodeTaskDef[], optional (bulk-register tasks)
    task fields:
      id     — string, optional (prefixed: programId_nodeId_taskId)
      title  — string, REQUIRED
      steps  — PlanNode[], REQUIRED (same as start-plan steps)

OUT: {
  ok: true, programId: "pgm_XXX", title: "...", totalNodes: 4,
  nodes: [ { nodeId: "pgm_XXX_wave0", title: "...", orderIndex: 1, status: "pending" } ],
  tasks: [
    { taskId: "pgm_XXX_wave0_T0", nodeId: "pgm_XXX_wave0", title: "...",
      totalSteps: 3, currentSteps: [], stepKeys: {} }
  ]
}
// All tasks start pending. stepKeys are EMPTY — use program start to activate.
```

### program start — Activate a node's tasks, get stepKeys

```
IN:  program start '{"programId":"pgm_XXX","nodeId":"pgm_XXX_wave0"}'

OUT (success): {
  ok: true, nodeId: "pgm_XXX_wave0", sessionId: "ses_XXX",
  tasks: [
    { taskId: "pgm_XXX_wave0_T0", nodeId: "pgm_XXX_wave0",
      title: "任务0", totalSteps: 3,
      currentSteps: [ { stepId: "pgm_XXX_wave0_T0_s1", path: "步骤1", index: 1, total: 3 } ],
      stepKeys: { "pgm_XXX_wave0_T0_s1": "X9K2WQ" }
    }
  ]
}

OUT (blocked — node deps unsatisfied): {
  ok: false, error: "NODE_NOT_READY",
  message: "Node has 1 unsatisfied dependencies",
  fix: "node dist/cli.js program status '{\"programId\":\"...\"}'"
}
```

### program status — Read program progress

```
IN:  program status '{"programId":"pgm_XXX"}'

OUT: {
  ok: true, programId: "pgm_XXX", title: "...",
  nodes: [ { nodeId, title, orderIndex, status } ]
}
```

### program rebuild — Rebuild after plan changes

```
IN:  program rebuild '{"programId":"pgm_XXX"}'          # dry-run
     program rebuild '{"programId":"pgm_XXX"}' --confirm # execute

OUT (dry-run): { ok: true, dryRun: true, scope, completedSteps, pendingSteps, ... }
OUT (confirm): { ok: true, confirmed: true, cancelledTasks: N, resetNodes: [...] }
```

## DAG rules

**Example — parallel branches + merge point:**
```bash
node dist/cli.js start-plan '{
  "title":"Backend refactor",
  "steps":[
    {"id":"auth","title":"Auth module","dependsOn":[]},
    {"id":"api","title":"API layer","dependsOn":[]},
    {"id":"db","title":"DB migration","dependsOn":["auth"]},
    {"id":"test","title":"Integration tests","dependsOn":["api","db"]}
  ]
}'
# auth + api activate immediately; db waits for auth; test waits for api + db
```

| dependsOn | Behavior |
|-----------|----------|
| `[]` (explicit empty) | Parallel entry — activated immediately |
| omitted / undefined | Auto-serial — depends on previous leaf |
| `["a", "b"]` | Merge point — unlocks after both a and b complete |
| Container with children | Children inherit the container's dependsOn |
| `skipKey` + `skipTaskId` | Skip a previously completed step (one-time use) |

Cycle detection runs at plan creation time — circular dependencies are rejected before
any step starts.

## Interruption recovery

When a session is interrupted, completed steps are permanent cryptographic proofs:

```bash
# Rebuild with skipKey to jump past already-completed steps
node dist/cli.js start-plan '{
  "title":"Resume wave 2",
  "steps":[
    {"id":"auth","title":"Auth module","dependsOn":[],"skipKey":"OLD_KEY","skipTaskId":"tsk_OLD"},
    {"id":"ci","title":"CI tests","dependsOn":["auth"]}
  ]
}'
```

A skipKey can only be consumed once — the system writes a `skip_key_consumed` event on
first use and rejects subsequent attempts. Skipped steps are marked `skipped` (not
`completed`) to preserve traceability.

## Key rules

1. Keys appear exactly once — in the checkpoint or start-plan response. If lost, they
   cannot be recovered. The `current` command never returns keys.
2. Step double-consumption is impossible — the DB transaction uses `WHERE status='current'`
   with an affected-rows guard.
3. Cancel-task is session-gated — agents cannot cancel tasks they don't own.
4. SkipKey is one-time — the `events` table records every consumption.
5. Cycle detection runs at plan creation — dead DAGs are rejected before execution.

The Gate is a proof-of-completion system, not a security product. It protects against
agent hallucination, context loss, and accidental step-skipping. It does not protect
against deliberate external attack.

## Session files

The first `start-plan` call creates:
- `.step-gate/sessions/ses_XXXXXX.json` — session credentials
- `.step-gate/bindings/bind_cli_XXXXXX.json` — hook binding

The CLI auto-discovers the session from binding files. No manual session management needed.

## Further reading

- `Weaver.md` — Multi-agent orchestration: how a Main Agent spawns Sub Agents, injects
  taskId + stepKey, and verifies returned taskKeys. Read this before orchestrating
  parallel Sub Agents.
