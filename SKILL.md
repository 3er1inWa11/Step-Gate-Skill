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

## Hierarchy

Every piece of work in Step Gate lives at exactly one of four levels:

```
Program     ← 跨会话的完整项目（如"重构整个后端"）
  ├─ Node   ← 一个执行阶段（如"Phase 1: 提取中间件"）
  │   ├─ Task   ← 一次 Agent 交互 = 一个 Task
  │   │   ├─ Step  ← 一个具体、可验证的动作（如"创建 auth.ts"）
  │   │   ├─ Step  ← 每个 Step 配一条一次性密钥
  │   │   └─ Step  ← DAG 依赖决定执行顺序
  │   └─ Task
  └─ Node
```

- **Program**: 最高层，跨多个会话。Node 全部完成自动传播。
- **Node**: 一个执行阶段，包含多个 Task。依赖排序决定何时激活。
- **Task**: 一次交互。一个 Task 包含多个 Step。
- **Step**: 最小执行单元。一个 Step = 一个具体动作 + 一条密钥。

**Step 粒度规则：**

Steps 必须够细，让 Sub Agent 无法跳步：

| 坏 Step | 好 Step |
|---------|---------|
| "重构 auth 模块" | "提取 auth middleware 到 src/middleware/auth.ts" |
| "写测试" | "为 auth.ts 写 3 个单元测试" |
| "更新文档" | "更新 README 的 Auth 章节" |

每个 Step 必须是一个可验证的完成/未完成二元问题。如果一个 Step 包含多个独立动作，拆成多个 Step。

## Why this exists

Long-context agents lose track of plans. A 15-step refactor becomes 12 steps in the
agent's memory by the time it reaches step 9. Context compression drops the original
plan. A Sub Agent claims "all done" when it skipped step 7.

The Gate solves this by moving the plan ledger **outside** the agent's context. The plan
lives in SQLite. Each step is locked behind a 6-character key. The key appears only once
in the checkpoint response — if the agent loses it, the step cannot be faked.

## Hierarchy — MANDATORY

**If Step Gate is enabled, you MUST use at least Task + Step level.** Even the simplest
single-step job requires a Task wrapping one Step. There is no way to skip this.

```
Program     ← 跨会话项目（多 Node 时使用）
  └─ Node   ← 一个执行阶段/波次
      └─ Task   ← 一次交互 = 一个 Task（MANDATORY）
          └─ Step  ← 一个具体动作 + 一条密钥（MANDATORY, 至少 1 个）
```

**A Task without Steps is invalid.** Every Task needs at least one Step. If your work
is just "run a command", that's one Step. If it's "refactor three files", that's
three Steps — each one independently checkpointable.

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

## CLI cheat sheet

```
node dist/cli.js --help                              Show all commands

start-plan  '<json>'                                  Create a Task
checkpoint  '{"taskId":"X","stepId":"Y","stepKey":"K"}' Submit proof
current     '{"taskId":"X"}'                         Read progress (NO keys)
finalize    '{"taskId":"X","taskKey":"K"}'            Close completed task
cancel-task '{"taskId":"X"}'                          Cancel task (session-gated)
active-task                                           List all active tasks

program init   '{"title":"P","nodes":[...]}'          Register full DAG
program start  '{"programId":"P","nodeId":"N"}'       Activate node + get keys
program status '{"programId":"P"}'                    Read program progress
program rebuild '{"programId":"P"}' --confirm          Rebuild after plan changes
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
