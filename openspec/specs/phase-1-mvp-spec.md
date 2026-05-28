# Agent Step Gate MCP Server — 功能规格

> 此文档仅供 CI Agent 黑盒测试使用。CI Agent 禁止阅读任何源码。

## MCP Server 基本信息

- **名称**: agent-step-gate
- **版本**: 0.1.0
- **传输**: stdio (JSON-RPC)
- **入口**: `node dist/index.js`

## 4 个 MCP Tool

### 1. gate_start_plan

**用途**: 创建一个任务计划，自动将嵌套步骤 flatten 为线性 leaf step 序列。

**输入参数**:
```json
{
  "title": "string（必填）",
  "steps": "PlanNode[]（必填，至少一个步骤）"
}
```

PlanNode 结构：
```json
{
  "title": "string",
  "children": "PlanNode[]（可选，不存在或为空数组视为 leaf）"
}
```

**输出**:
```json
{
  "taskId": "string（task_ 前缀 UUID）",
  "status": "active",
  "currentStep": {
    "stepId": "string",
    "path": "string（'父 / 子 / 孙' 格式）",
    "index": "number（从 1 开始）",
    "total": "number"
  },
  "stepKey": "string（sg_step_ 前缀，仅返回一次明文）"
}
```

**错误**: 空 title → PLANN_SCHEMA_INVALID；空 steps → PLANN_SCHEMA_INVALID

### 2. gate_current

**用途**: 查询当前应执行的步骤。

**输入参数**:
```json
{
  "taskId": "string（必填）"
}
```

**输出（active task 有 current step）**:
```json
{
  "taskId": "string",
  "status": "active",
  "currentStep": {
    "stepId": "string",
    "path": "string",
    "index": "number",
    "total": "number"
  }
}
```

**输出（task 已完成）**:
```json
{
  "taskId": "string",
  "status": "completed",
  "currentStep": null
}
```

**输出（task 不存在）**:
```json
{
  "taskId": "string",
  "status": "not_found",
  "currentStep": null
}
```

**安全**: gate_current 绝不返回 step_key 明文。

### 3. gate_checkpoint

**用途**: 完成当前步骤，领取下一步密钥。

**输入参数**:
```json
{
  "taskId": "string（必填）",
  "stepId": "string（必填）",
  "stepKey": "string（必填）"
}
```

**输出（普通步骤）**:
```json
{
  "accepted": true,
  "completedStep": { "stepId": "string", "path": "string" },
  "nextStep": { "stepId": "string", "path": "string", "index": "number", "total": "number" },
  "nextStepKey": "string（下一步的 step_key 明文）"
}
```

**输出（最后一步，全部完成）**:
```json
{
  "accepted": true,
  "completedStep": { "stepId": "string", "path": "string" },
  "allStepsCompleted": true,
  "finalKey": "string（sg_final_ 前缀）"
}
```

**输出（校验失败）**:
```json
{
  "accepted": false,
  "error": "TASK_NOT_FOUND | INVALID_CURRENT_STEP | INVALID_STEP_KEY | ...",
  "message": "string",
  "currentStep": "（可选）当前步骤信息"
}
```

**校验规则**:
1. task 必须存在且状态为 active
2. stepId 必须是当前步骤
3. stepKey hash 必须匹配
4. 不能跳步、不能重复使用已过期的 step_key

### 4. gate_finalize

**用途**: 用 final_key 校验并标记任务完成。

**输入参数**:
```json
{
  "taskId": "string（必填）",
  "finalKey": "string（必填）"
}
```

**输出（成功）**:
```json
{
  "accepted": true,
  "status": "completed",
  "message": "All planned steps have been checkpointed."
}
```

**输出（final_key 无效）**:
```json
{
  "accepted": false,
  "status": "active",
  "message": "string",
  "currentStep": "（可选）未完成的步骤信息"
}
```

**输出（task 不存在）**:
```json
{
  "accepted": false,
  "status": "not_found",
  "message": "Task not found."
}
```

**幂等**: 已完成 task 再次 finalize 返回 `accepted: true`。

## 状态机

- Task: `active` → `completed`
- Step: `pending` → `current` → `completed`
- 同一 task 同时只有一个 current step

## 错误码

```
TASK_NOT_FOUND — 任务不存在
TASK_ALREADY_COMPLETED — 任务已完成
NO_STEPS — 计划无步骤
INVALID_CURRENT_STEP — 不是当前步骤（跳步）
INVALID_STEP_KEY — step_key 不匹配（过期或错误）
INVALID_FINAL_KEY — final_key 无效
PLAN_SCHEMA_INVALID — 计划格式错误
INTERNAL_ERROR — 内部错误
```

## 密钥设计

- step_key: `sg_step_<64 位 hex 随机数>`，一次性使用，checkpoint 后立即失效
- final_key: `sg_final_<64 位 hex 随机数>`，所有步骤完成后才生成
- 数据库只存 SHA-256 hash，明文不持久化

## 验收标准

1. Agent 可以创建嵌套计划，系统自动 flatten 返回第一个 leaf step 和 step_key
2. 按序 checkpoint 每一步 → 返回下一步和新 step_key
3. 不可跳步、不可重复使用旧 key
4. 全部步骤完成后获得 final_key
5. 正确 final_key → finalize 成功
6. 错误 final_key → finalize 失败，返回未完成的当前步骤
7. 没有 final_key → 任务不能视为完成
