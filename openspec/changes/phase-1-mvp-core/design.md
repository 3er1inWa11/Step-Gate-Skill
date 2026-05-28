# Phase 1 — 设计文档

## 1. 系统架构

```
Agent (Claude Code)
    │ MCP Protocol (stdio JSON-RPC)
    ▼
agent-step-gate MCP Server
    │
    ├── Tools: startPlan, current, checkpoint, finalize
    ├── Core: plan (flatten), gate (state machine), keys (crypto)
    └── Storage: SQLite (better-sqlite3)
```

## 2. MCP Tools 规格

### 2.1 `gate_start_plan`

- **输入**: `{ title: string, steps: PlanNode[] }`
- **输出**: `{ task_id, status, current_step: { step_id, path, index, total }, step_key }`
- **逻辑**: flatten 嵌套 → 写入 tasks/steps 表 → 设置第 1 步为 current → 生成 step_key → 返回

### 2.2 `gate_current`

- **输入**: `{ task_id: string }`
- **输出**: `{ task_id, status, current_step: { step_id, path, index, total } }`
- **注意**: step_key 不在此返回。keys 只在创建时（gate_start_plan）或轮换时（gate_checkpoint）返回一次明文，query 时不返回明文（安全考虑）。

### 2.3 `gate_checkpoint`

- **输入**: `{ task_id, step_id, step_key }`
- **输出**: 普通步骤 → `{ accepted, next_step, next_step_key }`；最后一步 → `{ accepted, all_steps_completed, final_key }`
- **校验**: task 存在 → step_id 是当前步骤 → step_key hash 匹配 → 推进

### 2.4 `gate_finalize`

- **输入**: `{ task_id, final_key }`
- **输出**: 成功 → `{ accepted, status: "completed" }`；失败 → `{ accepted: false, current_step }`

## 3. 数据模型

### tasks 表
```sql
id TEXT PK, title TEXT, status TEXT, current_index INT, total_steps INT,
final_key_hash TEXT, created_at TEXT, updated_at TEXT
```

### steps 表
```sql
id TEXT PK, task_id TEXT FK, parent_path TEXT, title TEXT, path TEXT,
order_index INT, status TEXT, step_key_hash TEXT, completed_at TEXT, created_at TEXT
```

### events 表
```sql
id TEXT PK, task_id TEXT FK, step_id TEXT, event_type TEXT, payload TEXT, created_at TEXT
```

## 4. 状态机

- Task: `active → completed`（MVP 不做 cancelled）
- Step: `pending → current → completed`
- 同一 task 同时只有一个 current step

## 5. 密钥设计

- step_key: `sg_step_<crypto.randomBytes(32).toString('hex')>`
- final_key: `sg_final_<crypto.randomBytes(32).toString('hex')>`
- 数据库只存 SHA-256 hash
- step_key 一次性，checkpoint 后立即失效

## 6. 嵌套步骤 flatten

输入嵌套 PlanNode[] → DFS 遍历 → 只收 leaf（无 children 或 children 为空）→ 生成 `parentPath / title` 格式的 path → 分配 order_index

## 7. 错误码

```
TASK_NOT_FOUND, TASK_ALREADY_COMPLETED, NO_STEPS,
INVALID_CURRENT_STEP, INVALID_STEP_KEY, INVALID_FINAL_KEY,
PLAN_SCHEMA_INVALID, INTERNAL_ERROR
```
