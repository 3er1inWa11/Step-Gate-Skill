# Weaver — Step Gate 编排引擎

## 三层角色

```
Main Agent (编排者)       ← 持有 Node/Program 全局视角
  │                          只做三件事: 派发、校验、推进
  │                          不写代码、不执行 Step
  │
  ├── Sub Agent A            ← 只知道自己的 taskId + taskGoal
  ├── Sub Agent B            ← 不知道其他 Task、不知道 DAG
  └── Sub Agent C            ← 不知道 Node/Program 全局
```

Sub Agent 的上下文由 Main Agent 在 Spawn 时精确注入。看不到全局计划，不知道前后 Task，不持有验证逻辑。

## 完整执行流程

```
═══════════════════════════════════════════════════════
Phase 0 — 规划
═══════════════════════════════════════════════════════
Main Agent:
  program init → 拆分 Node
  reconcile → 日常诊断

═══════════════════════════════════════════════════════
Phase 1 — 启动 Node
═══════════════════════════════════════════════════════
Main Agent:
  program start <node-id>        ← 绑定 session 到 node
  start-plan → 创建 Task(DAG)    ← 一次交互 = 一个 Task
  → 拿到 taskId + stepKeys

═══════════════════════════════════════════════════════
Phase 2 — 派发
═══════════════════════════════════════════════════════
Main Agent → Sub Agent:
  {
    "taskId": "tsk_XXX",
    "taskGoal": "抽离认证中间件",
    "constraints": ["只处理本Task范围", "完成后调checkpoint"]
  }

Sub Agent 在同一工作目录启动:
  → ensureSession() 自动从 .step-gate/bindings/ 发现 session
  → 无需手动传 sessionId

═══════════════════════════════════════════════════════
Phase 3 — Sub Agent 执行循环
═══════════════════════════════════════════════════════
Sub Agent:
  current(taskId)
    → { currentSteps, stepKeys }

  for each step:
    执行 step
    checkpoint(taskId, stepId, stepKey)
      → { nextSteps, nextStepKeys }
      → 或 { allStepsCompleted: true, taskKey }

═══════════════════════════════════════════════════════
Phase 4 — 交回凭证
═══════════════════════════════════════════════════════
Sub Agent → Main Agent:
  {
    "taskId": "tsk_XXX",
    "taskKey": "A1B2C3",
    "summary": "完成认证中间件抽离",
    "artifacts": ["src/middleware/auth.ts"]
  }

═══════════════════════════════════════════════════════
Phase 5 — Main Agent 校验 + 自动推进
═══════════════════════════════════════════════════════
Main Agent:
  finalize(taskId, taskKey)

  ✅ 通过:
    → 返回 { ok: true, level, ... }
    → level="task":    Node 还有未完成的 Task，继续派发
    → level="node":    Node 完成! nodeKey 返回，自动推进
    → level="program": 全部 Node 完成! 收工
    → Sub Agent 释放

  ❌ 不通过:
    → 返回 { actualStatus, completedSteps, missingSteps,
             currentStepId, stepKey }
    → Main Agent 把真实账本发回 Sub Agent:
        "你的 TaskKey 未通过 Gate 校验。
         已完成: step_001, step_002
         缺失:   step_003, step_004
         当前应继续 step_003，StepKey: SK_REAL33"
    → Sub Agent 从 currentStepId 继续 checkpoint
    → 修完重新 finalize

═══════════════════════════════════════════════════════
Phase 6 — 下一个 Node (自动)
═══════════════════════════════════════════════════════
finalize 返回 level="node" 时，Main Agent:
  program status → 找下一个 ready node
  program start <next-node>
  → 创建新 Task → 派发 → 循环

═══════════════════════════════════════════════════════
收尾
═══════════════════════════════════════════════════════
最后一个 Node 完成:
  finalize → level="program" → Program completed
  收工
```

## 关键设计点

**Main Agent 只调一个命令**：`finalize(taskKey)`。剩下的系统自动从 Task → Node → Program 传播。

**TaskKey 校验即消费**：finalize 会消耗 taskKey 并推进 DAG，不存在"校验通过但不推进"的状态。

**Sub Agent 不需要知道**：
- taskId 的结构含义
- 完整的 DAG
- 前后 Task 是什么
- Node/Program 全局
- 验证逻辑（系统自己校验）

**中断恢复**：taskId + skipKey 重建，旧 step 凭证永久保留。

**纯 Task 模式**：不用 Program/Node 时，只需 `start-plan → checkpoint → finalize`。每个交互一个 Task，交互结束 Stop Hook 自动检查。

## 渐进式披露

```
SKILL.md (执行协议)         ← 所有 Agent 必读，基础 CLI 命令
  └─ Weaver.md (编排引擎)   ← Main Agent 读，如何编排 Sub Agent
       └─ CLI (状态机)       ← 底层实现
            └─ SQLite (持久化)
```

Sub Agent 只需要 SKILL.md 中的 CLI 命令，不需要 Weaver.md。
Main Agent 需要 SKILL.md + Weaver.md。
