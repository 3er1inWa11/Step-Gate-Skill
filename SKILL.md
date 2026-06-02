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

| 太粗 (不能用)     | 刚好 (可以用)                                      |
| ------------ | --------------------------------------------- |
| "重构 auth 模块" | "提取 auth middleware 到 src/middleware/auth.ts" |
| "写测试"        | "为 auth.ts 写 3 个单元测试"                         |
| "更新文档"       | "更新 README 的 Auth 章节"                         |
| "修 bug"      | "修复 login 页面的空指针异常"                           |

如果一个 Step 描述包含"和"、"以及"、"同时"——拆成多个 Step。

## 核心规则 — 单 Task 工作流

适合一次交互完成的工作：

1. **规划** — 把工作拆成具体的 Step，定义 DAG 依赖
2. **展示 DAG 给用户** — 在调用 `start-plan` 之前展示完整步骤计划
3. **获取确认** — 用户必须明确批准计划
4. **注册** — 调用 `start-plan` 将计划锁定到外部账本
5. **执行** — 每完成一个 Step 立即 checkpoint
6. **关闭** — 提交 taskKey 关闭 Task

```
规划 → 展示 DAG → 用户确认 → start-plan → checkpoint × N → finalize(taskKey) → 完成
```

## 核心规则 — 多 Wave Program 工作流

适合跨会话、多阶段、多 Agent 协同的工作：

```
program init → 展示 DAG → 用户确认
  ↓
  ┌─────────────────────────────────────────────────────┐
  │  每个 Wave (Node) 循环:                              │
  │    program start <node>  →  激活任务                 │
  │    ↓                                                │
  │    Main Agent 派发 Sub Agent                        │
  │    (按 Weaver 协议注入 taskId + stepKeys)            │
  │    ↓                                                │
  │    Sub Agent → checkpoint × N → taskKey              │
  │    ↓                                                │
  │    Main Agent → finalize(taskId, taskKey)            │
  │    ↓                                                │
  │    Node 内所有 Task 完成 → Node 自动完成             │
  │    ↓                                                │
  │    用户手动启动下一波:                               │
  │    program start <next-node>                        │
  └─────────────────────────────────────────────────────┘
```

**每个 Wave 需要显式 `program start`。** Wave 不会自动级联——这是刻意设计。一次交互不应该自动跑完所有 Wave（Stop Hook 永远不会让会话结束）。

## 主动 Checkpoint

每完成一个 Step，立即调用 `checkpoint` 并出示密钥。不要批量 checkpoint，不要等 Hook 来提醒。Hook 是安全网，不是工作流。看到 `ACTION REQUIRED`，立刻停下来解决。

## 大 DAG 注册 — 先写文件再注册

当 Program 包含大量 Node/Task/Step 时（如 29 个 Task、145 个 Step），Bash 参数长度限制可能截断 JSON。**始终先把 JSON 写到临时文件：**

```bash
# 把 Program DAG 写到文件
cat > /tmp/dag.json << 'EOF'
{"title":"...","nodes":[...]}
EOF

# 从文件注册
node dist/cli.js program init "$(cat /tmp/dag.json)"
```

超过 ~10 行的 JSON 不要直接内联到 Bash 命令中。写文件，然后 `cat`。

## Weaver 协议 — 派发 Sub Agent 时必须复制此模板

**派发 Sub Agent 时，必须把下面的派发模板复制到 Sub Agent 的 Prompt 中。** Sub Agent 无法自行发现任务或密钥。

```
⛔ 先读这里 — 你是 Step Gate 下的 Sub Agent

工作目录: <项目根目录>
CLI 命令: node dist/cli.js

你的任务已由 Main Agent 预注册。你不需要创建任务。

当前分配的步骤:
  任务 ID: <taskId>
  步骤: <stepId> — "<步骤描述>" — 密钥: <stepKey>

规则:
1. 先 cd <项目根目录> 再执行任何 step-gate 命令
2. 完成当前步骤后，立即 checkpoint:
   node dist/cli.js checkpoint '{"taskId":"<taskId>","stepId":"<stepId>","stepKey":"<stepKey>"}'
3. checkpoint 响应中 nextSteps + nextStepKeys 表示解锁的下一步
4. checkpoint 返回 allStepsCompleted=true + taskKey 时，停止并回报 taskKey
5. 用 node dist/cli.js current '{"taskId":"<taskId>"}' 查看进度（会返回当前 stepKey）
6. 永远不要调用 finalize — 那是 Main Agent 的职责
7. 永远不要调用 start-plan、cancel-task、program 命令
8. stepKey 明文存储在 DB 中，可通过 current 命令恢复

全部步骤完成后: 回报 taskId + taskKey + 完成摘要给 Main Agent
```

**不在 Sub Agent Prompt 中包含此模板，是 Sub Agent 不 checkpoint 的第一大原因。** 始终复制完整模板。

## CLI 完整参考 — 每个命令的精确输入/输出

所有命令都接受**恰好一个 JSON 字符串参数**（跟在命令名后面）。所有输出都是 JSON 到 stdout。退出码 0 = 成功，非零 = 错误。

### start-plan — 创建 Task 和 Step

```
输入:  start-plan '{"title":"任务名","steps":[{"id":"s1","title":"步骤1","dependsOn":[]}]}'

step 字段:
  id         — 字符串，可选（不填自动生成）
  title      — 字符串，必填
  dependsOn  — 字符串数组，可选（[]=立即激活, 省略=串行, ["a","b"]=合并点）
  children   — PlanNode[]，可选（嵌套子步骤）
  skipKey    — 字符串，可选（中断恢复时跳过已完成步骤的旧密钥）
  skipTaskId — 字符串，可选（skipKey 对应的旧 taskId）

输出: {
  ok: true,
  taskId: "tsk_A1B2C3",
  session: { sessionId, sessionSecret, recoveryToken, cliInstanceId },
  totalSteps: 3,
  currentSteps: [ { stepId: "tsk_A1B2C3_s1", path: "步骤1", index: 1, total: 3 } ],
  stepKeys: { "tsk_A1B2C3_s1": "X9K2WQ" }
}
```

### checkpoint — 完成一个步骤，解锁后续步骤

```
输入:  checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_yy","stepKey":"X9K2WQ"}'

输出 (有后续步骤): {
  ok: true,
  completedStep: { stepId: "tsk_XXX_yy", path: "步骤1" },
  nextSteps: [ { stepId: "tsk_XXX_zz", path: "步骤2", index: 2, total: 3 } ],
  nextStepKeys: { "tsk_XXX_zz": "A1B2C3" }
}

输出 (最后一步 — 全部完成): {
  ok: true,
  completedStep: { stepId: "tsk_XXX_zz", path: "最后一步" },
  allStepsCompleted: true,
  taskKey: "D4E5F6"     ← 保存此密钥，回报给 Main Agent
}

输出 (并行分支等待): {
  ok: true,
  completedStep: { stepId: "...", path: "..." }
  // 没有 nextSteps — 其他并行分支还在执行
}

输出 (错误): {
  ok: false, error: "INVALID_STEP_KEY", message: "密钥不匹配",
  currentStep: { stepId, path, index, total },
  fix: "node dist/cli.js checkpoint '{\"taskId\":\"...\",\"stepId\":\"...\",\"stepKey\":\"...\"}'"
}
```

### current — 查看进度（始终返回当前 stepKey，用于中断恢复）

```
输入:  current '{"taskId":"tsk_XXX"}'

输出: {
  taskId: "tsk_XXX",
  status: "active",
  totalSteps: 3,
  completedSteps: 1,
  currentSteps: [
    { stepId: "tsk_XXX_s2", path: "步骤2", index: 2, total: 3,
      stepKey: "A1B2C3" }   ← 当前步骤的明文密钥，始终返回
  ]
}

输出 (未找到): { taskId: "...", status: "not_found", currentSteps: [] }
```

### finalize — 关闭已完成的 Task

```
输入:  finalize '{"taskId":"tsk_XXX","taskKey":"D4E5F6"}'

输出 (成功): {
  ok: true, level: "task", taskId: "tsk_XXX", taskStatus: "completed"
}
// level 可能为 "task" | "node" | "program" — 自动向上传播

输出 (拒绝 — 步骤未完成): {
  ok: false, status: "active", level: "task",
  message: "Steps not checkpointed",
  pendingSteps: [ { stepId, path, index, total } ],
  fix: "node dist/cli.js checkpoint '{\"taskId\":\"...\",\"stepId\":\"...\",\"stepKey\":\"...\"}'"
}
```

### active-task — 列出所有活跃 Task（默认跨 Session）

```
输入:  active-task

输出: {
  activeTasks: [
    { taskId: "tsk_XXX", title: "...", status: "active",
      sessionId: "ses_XXX", totalSteps: 3,
      completedSteps: 1,
      currentSteps: [ { stepId, path, index, total } ]
    }
  ]
}
```

### cancel-task — 取消一个 Task

```
输入:  cancel-task '{"taskId":"tsk_XXX"}'

输出: { ok: true, message: "Task cancelled." }
// Session 门控。跨 Session 取消需要 --admin --recovery-token <token>
```

### program init — 一次性注册完整 Program→Node→Task→Step DAG

```
输入:  program init '{"title":"项目名","nodes":[
  {"id":"wave0","title":"阶段0","tasks":[
    {"id":"T0","title":"任务0","steps":[
      {"id":"s1","title":"步骤1","dependsOn":[]},
      {"id":"s2","title":"步骤2","dependsOn":["s1"]}
    ]},
    {"id":"T1","title":"任务1","steps":[
      {"id":"s3","title":"步骤3","dependsOn":["T0"]}
      // ↑ Step 可依赖另一个 Task（容器引用，表示等 T0 全部完成）
    ]}
  ]},
  {"id":"wave1","title":"阶段1","dependsOn":["wave0"],"tasks":[...]}
]}'

三层依赖:
  Step 级   — dependsOn: ["同Task的stepId"] 或 ["其他Task的id"]（容器引用=等该Task全部完成）
  Task 级   — 通过 Step 的 dependsOn 引用其他 Task 的 id 实现（Task 本身无独立 dependsOn 字段）
  Node 级   — dependsOn: ["其他Node的id"]（Node 完成前不能启动）

输出: {
  ok: true, programId: "pgm_XXX", title: "...", totalNodes: 4,
  nodes: [ { nodeId: "pgm_XXX_wave0", title: "...", orderIndex: 1, status: "pending" } ],
  tasks: [
    { taskId: "pgm_XXX_wave0_T0", nodeId: "pgm_XXX_wave0", title: "...",
      totalSteps: 3, currentSteps: [], stepKeys: {} }
  ]
}
// 所有 Task 初始为 pending。stepKeys 为空 — 用 program start 激活获取密钥。
```

### program start — 激活一个 Node 的 Task，获取 stepKeys

```
输入:  program start '{"programId":"pgm_XXX","nodeId":"pgm_XXX_wave0"}'

输出 (成功): {
  ok: true, nodeId: "pgm_XXX_wave0", sessionId: "ses_XXX",
  tasks: [
    { taskId: "pgm_XXX_wave0_T0", nodeId: "pgm_XXX_wave0",
      title: "任务0", totalSteps: 3,
      currentSteps: [ { stepId: "pgm_XXX_wave0_T0_s1", path: "步骤1", index: 1, total: 3 } ],
      stepKeys: { "pgm_XXX_wave0_T0_s1": "X9K2WQ" }
    }
  ]
}

输出 (被拦截 — Node 依赖未满足): {
  ok: false, error: "NODE_NOT_READY",
  message: "Node has 1 unsatisfied dependencies",
  fix: "node dist/cli.js program status '{\"programId\":\"...\"}'"
}
```

### program status — 查看 Program 进度

```
输入:  program status '{"programId":"pgm_XXX"}'

输出: {
  ok: true, programId: "pgm_XXX", title: "...",
  nodes: [ { nodeId, title, orderIndex, status } ]
}
```

### program rebuild — 计划变更后重建

```
输入:  program rebuild '{"programId":"pgm_XXX"}'          # 试运行
      program rebuild '{"programId":"pgm_XXX"}' --confirm # 执行

输出 (试运行): { ok: true, dryRun: true, scope, completedSteps, pendingSteps, ... }
输出 (执行):   { ok: true, confirmed: true, cancelledTasks: N, resetNodes: [...] }
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
