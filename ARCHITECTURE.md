# Agent Step Gate — 完整架构文档

**版本**: 0.3.0 | **日期**: 2026-05-30 | **测试**: 116/116

---

## 1. 四层架构

```
Program (pgm_XXXXXX)              ← 跨 Session 大计划
  └─ Node (pg-xxx)                ← 一个 Session 的工作单元
       └─ Task (tsk_XXXXXX)       ← 一个 DAG 计划
            └─ Step               ← 最小执行单元
```

每层都有对应的完成凭证：
```
stepKey ──→ taskKey ──→ nodeKey ──→ program (自检)
 (出示)      (出示)      (收据)       (自动)
```

### 自底向上传播

`finalize` 命令一次调用，自动逐层上浮：

```
finalize(taskKey)
  → task completed
  → 检查: 同 node 全部 task completed?
    → 是 → 生成 nodeKey → node completed
    → 检查: 同 program 全部 node completed?
      → 是 → program completed
```

Agent 不需要判断层级——系统自己知道该传播到哪。

---

## 2. 数据库 — 7 张表

### programs
```sql
program_id    TEXT PK   -- pgm_XXXXXX
title         TEXT
status        TEXT     -- active | completed
total_nodes   INTEGER
created_at / updated_at
```

### program_nodes
```sql
node_id       TEXT PK   -- user-defined or pg_xxx_N
program_id    TEXT FK
title / description / order_index
status        TEXT     -- pending | in_progress | completed
session_id    TEXT
node_key_hash TEXT     -- SHA-256(6-char nodeKey), system-generated
completed_at / created_at
```

### sessions
```sql
session_id          TEXT PK   -- ses_XXXXXX
session_secret_hash TEXT     -- SHA-256(6-char)
recovery_token_hash TEXT     -- SHA-256(6-char)
title / workspace
program_id / program_node_id
status              TEXT     -- active | completed | abandoned
created_by_cli / created_at / updated_at
```

### cli_instances
```sql
cli_instance_id   TEXT PK   -- cli_XXXXXX
session_id / hostname / pid / workspace
status            TEXT     -- active | dead | detached
created_at / last_seen_at
```

### tasks
```sql
id              TEXT PK   -- tsk_XXXXXX
title / status            -- active | completed | cancelled
current_index / total_steps
final_key_hash  TEXT     -- SHA-256(taskKey)
session_id      TEXT FK
created_at / updated_at
```

### steps
```sql
id              TEXT PK   -- {taskId}_{nodeId}
task_id / parent_path / title / path
order_index / depends_on (JSON)
status          TEXT     -- pending | current | completed | skipped
step_key_hash   TEXT     -- SHA-256(stepKey), 完成后保留为永久凭证
completed_at / created_at
```

### events
```sql
id / task_id / step_id
event_type      TEXT     -- plan_created | step_activated | step_completed
                         -- all_steps_completed | task_finalized | task_cancelled
                         -- skip_key_consumed
payload / created_at
```

---

## 3. 安全模型 — 5 种凭证

| 凭证 | 长度 | 用途 | 生成者 | 验证方式 | 生命周期 |
|------|------|------|--------|---------|---------|
| **stepKey** | 6位 | 证明单个 step 完成 | 系统(plan/checkpoint) | SHA-256 hash 匹配 | 一次性，checkpoint 后消耗 |
| **taskKey** | 6位 | 证明全部 step 完成 | 系统(最后一步 checkpoint) | SHA-256 hash 匹配 | 一次性，finalize 后消耗 |
| **nodeKey** | 6位 | Node 完成凭证(收据) | 系统(finalize 自动传播) | SHA-256 hash 存 DB | 作为完成凭证返回给 Agent |
| **sessionSecret** | 6位 | Session 身份认证 | 系统(createSession) | SHA-256 hash 匹配 | Session 生命周期 |
| **recoveryToken** | 6位 | 崩溃恢复 + 管理操作 | 系统(createSession) | SHA-256 hash 匹配 | Session 生命周期 |

### 隔离规则
- Task 写操作：session_id 列强制过滤
- cancel-task：必须同 session，或出示 recoveryToken (--admin)
- checkpoint 原子性：`WHERE status='current' + affected rows` 防双消费
- stepKey 一次性：key_hash 保留作永久凭证，但 step 只能 checkpoint 一次

### skipKey 验证 (中断恢复)
- 旧 task 的 completed step 可作 skipKey 跳过新 task 的重复步骤
- `verifySkipKey()` 检查：hash 匹配 + status='completed' + events 表无 `skip_key_consumed`
- 验证通过后立即写入 `skip_key_consumed` 事件——确保一次性使用
- 跳过步骤标记为 `skipped`（非 `completed`），保留溯源

---

## 4. DAG 引擎

### 输入格式
```json
{
  "title": "Plan",
  "steps": [
    {"id":"a","title":"A","dependsOn":[]},
    {"id":"b","title":"B","dependsOn":["a"]},
    {"id":"c","title":"C","dependsOn":[],"skipKey":"OLD","skipTaskId":"tsk_OLD"}
  ]
}
```

### 展开规则
1. `dependsOn: []` → 并行起点，初始即激活
2. `dependsOn: undefined` → 自动串行，依赖前一个叶子
3. `dependsOn: ["b","c"]` → b 和 c 都完成后才解锁
4. `skipKey + skipTaskId` → 验证通过后标记 `skipped`
5. 嵌套 children → 递归展开为叶子节点

### 解锁算法
```
checkpoint(stepX):
  1. 标记 stepX = completed (保留 key_hash)
  2. 扫描 pending steps：
     dependsOn 全部 completed/skipped → 标记 current，生成 key
  3. 无新解锁 + 全部 completed/skipped → 生成 taskKey
```

---

## 5. CLI 命令全集 (12 个)

### Task 级
| 命令 | 输入 | 输出 |
|------|------|------|
| `start-plan '<json>'` | title + steps[] | taskId, session, totalSteps, currentSteps, stepKeys |
| `checkpoint '<json>'` | taskId + stepId + stepKey | completedStep, nextSteps, nextStepKeys, taskKey |
| `current '<json>'` | taskId | status, totalSteps, completedSteps, currentSteps |
| `finalize '<json>'` | taskId + taskKey | level(task/node/program), nodeKey(if), program(if) |
| `cancel-task '<json>'` | taskId | ok / error(NO_SESSION) |
| `active-task` | — | activeTasks[] (session-filtered) |
| `active-task --all` | — | activeTasks[] (跨 session) |

### Program 级
| 命令 | 输入 | 输出 |
|------|------|------|
| `program init '<json>'` | title + nodes[] | programId, totalNodes, nodes |
| `program status '<json>'` | programId | programId, title, nodes[] |
| `program ready '<json>'` | programId | readyNodes[] |
| `program start '<json>'` | programId + nodeId | ok, nodeId, sessionId |
| `program finalize '<json>'` | programId | ok, pending[] |

### Session 绑定方式
- `--session-file <path>` — 显式指定 session 文件
- `--binding-file <path>` — 通过 binding 文件间接指定
- `STEP_GATE_SESSION_FILE` / `STEP_GATE_BINDING_FILE` 环境变量
- 自动发现 `.step-gate/bindings/` 中最新的 binding（回退）

### Admin 模式
- `cancel-task --admin --recovery-token <token>` — 跨 session 取消

---

## 6. 核心函数 (20+)

### src/core/plan.ts
| 函数 | 作用 |
|------|------|
| `flattenPlan(nodes, taskId) → LeafStep[]` | 嵌套展开 + DAG 依赖解析 |

### src/core/keys.ts
| 函数 | 作用 |
|------|------|
| `randomCode(length) → string` | [A-Z0-9] 随机码 |
| `generateStepKey() → {plaintext, hash}` | 6位 step key |
| `generateTaskKey() → {plaintext, hash}` | 6位 task key |
| `generateNodeKey() → {plaintext, hash}` | 6位 node key |
| `hashKey(plaintext) → string` | SHA-256 |

### src/core/gate.ts
| 函数 | 作用 |
|------|------|
| `validateCheckpoint(repo, taskId, stepId, stepKey)` | 5步校验（task存在/active/current匹配/key匹配） |
| `advanceSteps(repo, task, completedStepId)` | 解锁后继步骤或生成 taskKey |
| `GateRepository` (interface) | 仓库抽象：getTask/getCurrentSteps/getTaskSteps/completeAndAdvance/updateTaskStatus/verifyTaskKey |

### src/core/session.ts
| 函数 | 作用 |
|------|------|
| `createSession(workspace) → SessionInfo` | 创建 session + 写入文件 |
| `verifySessionSecret(sessionId, secret)` | 校验 session 凭据 |
| `verifyRecoveryToken(sessionId, token)` | 校验恢复凭据 |
| `isSessionActive(sessionId)` | 检查状态 |
| `getCurrentSessionId()` | 进程内共享 sessionId |

### src/core/program.ts
| 函数 | 作用 |
|------|------|
| `createProgram(title, nodes[]) → ProgramInfo` | 创建 Program |
| `getProgramStatus(programId) → ProgramInfo` | 查询状态 |
| `getReadyNodes(programId) → ProgramNodeInfo[]` | 可开始的 node |
| `startProgramNode(programId, nodeId, sessionId)` | 绑定 session |
| `commitProgramNode(sessionId)` | 自动生成 nodeKey + 标记 node 完成 |
| `finalizeProgram(programId)` | 全局完整性检查 |

### src/storage/repository.ts
| 函数 | 作用 |
|------|------|
| `createTask(task, steps[])` | 原子写入 task + steps |
| `getTask(taskId)` | 查询 task |
| `getCurrentSteps(taskId)` | 查询活跃步骤 |
| `getTaskSteps(taskId)` | 查询所有步骤 |
| `getActiveTasks(sessionId?)` | 活跃 task（可选 session 过滤） |
| `completeAndAdvance(...)` | 原子完成+推进（事务保护） |
| `verifyStepKey(taskId, stepId, key)` | 严格校验（status='current'） |
| `verifyTaskKey(taskId, key)` | 校验 taskKey |
| `verifySkipKey(oldTaskId, stepId, oldKey)` | 验证 skip 凭证 + 检查消费事件 |
| `recordSkipConsumed(taskId, stepId)` | 写入 skip_key_consumed 事件 |
| `cancelTask(taskId, sessionId)` | 取消（session 门控） |
| `updateTaskStatus(taskId, status)` | 更新状态 |
| `addEvent(taskId, stepId, type, payload?)` | 事件记录 |
| `getEvents(taskId)` | 查询事件 |

---

## 7. Hook 系统

### SessionStart (`scripts/session-start-hook.sh`)
```
触发: 每次终端启动
策略: 轻量优先 — 读 data/state.json (1ms)，无结果才调 CLI
行为:
  1. 读 state.json → 有活跃 task → 警告 + 列出进度
  2. state 为空 → active-task --all → 跨 session 检查
  3. 无未完成 → 提醒可用命令
```

### Stop (`.claude/settings.local.json`)
```
触发: Session 结束前
行为:
  调用 finalize(taskKey) → 系统自动传播到 node/program
  如无 taskKey → 拦截提醒
```

### State File (`data/state.json`)
```
写入时机: start-plan / checkpoint / finalize / cancel-task 后
内容: { hasActiveTask, activeTasks: [{taskId, title, completed, total, current}] }
用途: SessionStart 1ms 快照，跨互动提醒
```

---

## 8. 文件布局

```
project/
  src/
    cli.ts                       ← CLI 入口 (504行, 12命令)
    index.ts                     ← MCP Server 入口 (备用)
    core/
      plan.ts                    ← DAG 展开
      keys.ts                    ← 三层密钥生成
      gate.ts                    ← 校验 + 解锁状态机
      session.ts                 ← Session 管理
      program.ts                 ← Program 层
      errors.ts                  ← GateError
    storage/
      db.ts                      ← SQLite (WAL, busy_timeout=5000)
      repository.ts              ← 数据层 (20+ 函数)
    tools/                        ← MCP 工具 (备用)
      startPlan.ts / checkpoint.ts / current.ts
      finalize.ts / cancelTask.ts / activeTask.ts / index.ts
    types/
      index.ts                   ← 全部类型定义
  tests/
    core.test.ts                 ← 36 tests
    storage.test.ts              ← 34 tests
    tools.test.ts                ← 29 tests (含 A1/B1)
    ci-blackbox.test.ts          ← 15 tests (MCP 协议级)
    e2e-smoking-app.test.ts      ← E2E 强制回退
    e2e-multi-agent.test.ts      ← E2E 多Agent协作
  scripts/
    session-start-hook.sh
    prompt-check-hook.sh
  mcp-backup/                    ← MCP 完整备份
  data/
    gate.db                      ← SQLite 数据库
    state.json                   ← 轻量快照
  .step-gate/
    sessions/                    ← Session 凭据文件
    bindings/                    ← CLI 绑定文件
  openspec/changes/              ← 变更文档
  SKILL.md                       ← Skill 定义
  ARCHITECTURE.md                ← 本文档
```

---

## 9. 错误码

| 错误码 | 含义 |
|--------|------|
| TASK_NOT_FOUND | taskId 不存在 |
| TASK_ALREADY_COMPLETED | 任务已完成 |
| NO_STEPS | 计划无步骤 |
| INVALID_CURRENT_STEP | 步骤不在当前状态 |
| INVALID_STEP_KEY | stepKey 校验失败 |
| INVALID_FINAL_KEY | taskKey 校验失败 |
| INVALID_RECOVERY_TOKEN | recoveryToken 校验失败 |
| PLAN_SCHEMA_INVALID | 计划格式错误 |
| SKIP_VERIFY_FAILED | skip 凭证验证失败或已消费 |
| NO_SESSION | 无 session 绑定 |
| INTERNAL_ERROR | 数据库/内部错误 |

---

## 10. 典型流程

### 单 Session
```bash
start-plan → checkpoint × N → finalize taskKey
# → 自底向上: task → node → program (如有)
```

### 中断恢复
```bash
start-plan → checkpoint auth ✅
  → current (查状态) → cancel-task
  → start-plan (skipKey+skipTaskId 重建，旧 key 被消费)
  → checkpoint → finalize taskKey
```

### 跨 Session Program
```bash
program init → program start pg-1
  → start-plan → checkpoint × N → finalize taskKey
# ↑ 自动标记 pg-1 completed + nodeKey 生成

program start pg-2
  → start-plan → checkpoint × N → finalize taskKey
# ↑ 自动标记 pg-2 completed，program completed
```

---

## 11. 技术栈

- **Runtime**: Node.js 20+
- **Language**: TypeScript ESM
- **Storage**: better-sqlite3 (WAL, synchronous=NORMAL, busy_timeout=5000)
- **Validation**: Zod v4 (MCP tools)
- **Test**: vitest (116 tests, 6 suites)
- **Key**: crypto.randomBytes → [A-Z0-9]{6} → SHA-256
- **IDs**: 6位 [A-Z0-9] (36^6 ≈ 21亿熵)
- **MCP SDK**: @modelcontextprotocol/sdk v1.x (备用)
