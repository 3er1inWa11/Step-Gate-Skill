# NEWSYSEMLOG — 系统变更日志

## 2026-05-28

### 项目初始化
- 创建项目目录结构
- 初始化 CodeGraph 索引
- 创建 OpenSpec Phase 1 文档（proposal.md, tasks.md, design.md）
- 配置 CodeGraph sync Hook（PostToolUse: Edit/Write → codegraph sync）
- 创建基础文档（CLAUDE.md, AGENT_PLAYBOOK.md, Experience.md）

---

### Wave 1 (A1) — 基础设施初始化
- 创建 `package.json`（@modelcontextprotocol/sdk, better-sqlite3, vitest, typescript）
- 创建 `tsconfig.json`（ES2022, NodeNext, strict mode）
- 创建 `src/types/index.ts`（PlanNode, LeafStep, TaskRow, StepRow, EventRow, 4 个 Tool I/O 类型）
- 创建 `src/core/errors.ts`（GateErrorCode 枚举, GateError 类）

---

### Wave 2 (A2) — 数据持久化层
- 创建 `src/storage/db.ts`（SQLite 初始化，better-sqlite3，WAL 模式，tasks/steps/events 三表建表）
- 创建 `src/storage/repository.ts`（完整 CRUD + 密钥校验，事务安全，GateError 错误处理）
- 创建 `tests/storage.test.ts`（vitest，覆盖 createTask / getTask / getCurrentStep / getTaskSteps / completeStep / setCurrentStep / updateTaskStatus / setFinalKeyHash / verifyStepKey / verifyFinalKey / addEvent / getEvents）
- 创建 `vitest.config.ts`

---

### Wave 2 (A3) — 核心业务逻辑
- 创建 `src/core/keys.ts`（generateStepKey, generateFinalKey, hashKey）
- 创建 `src/core/plan.ts`（flattenPlan — 嵌套步骤 flatten）
- 创建 `src/core/gate.ts`（validateCheckpoint, advanceStep — 状态机 + GateRepository 接口）
- 创建 `tests/core.test.ts`（单元测试，覆盖 keys / plan / gate 三个模块）
- 更新 `vitest.config.ts`（添加 tests include pattern）

---

### Bug Fix (A2) — snake_case / camelCase 映射修复
- **问题**：`repository.ts` 中 `SELECT *` 返回的 SQLite 行对象使用蛇形列名（`order_index`, `current_index`, `step_key_hash` 等），但 TypeScript 类型使用驼峰（`orderIndex`, `currentIndex`, `stepKeyHash` 等），直接用 `as TaskRow` 强制转换导致属性全是 `undefined`
- **修复**：添加 `mapTaskRow` / `mapStepRow` / `mapEventRow` 三个映射函数，在 `getTask` / `getCurrentStep` / `getTaskSteps` / `getEvents` 中调用
- **影响文件**：`src/storage/repository.ts`, `tests/storage.test.ts`
- **测试**：54/54 通过

（后续各 Wave 变更由对应 Agent 追加）

---

### Bug Fix (A3) — advanceStep 事务保护 + GateRepository 接口补齐 (2026-05-28)

**问题 1**：`advanceStep` 中 `completeStep` -> `setCurrentStep` -> `addEvent` 是 3 次独立 DB 调用，进程在中间崩溃会导致 task 陷入没有 current step 的僵死状态。

**修复**：
- 在 `repository.ts` 中新增 `completeAndAdvance()` 事务方法，将 step 完成 + 下一步激活 + event 记录 + current_index 更新包装在单个 SQLite 事务中
- 重写 `gate.ts` 中的 `advanceStep()`，改为调用 `repo.completeAndAdvance()` 一次性原子完成
- key 生成（`generateStepKey` / `generateFinalKey`）仍在 gate 层完成，hash 传给 repo 事务

**问题 2**：`GateRepository` 接口缺少 `updateTaskStatus` 和 `verifyFinalKey` 方法，Wave 3 的 `gate_finalize` 工具无法使用。

**修复**：
- 在 `GateRepository` 接口中增加 `completeAndAdvance`、`updateTaskStatus`、`verifyFinalKey` 三个方法签名
- 移除不再被 gate 层调用的旧方法（`completeStep`、`setCurrentStep`、`setFinalKeyHash`、`addEvent`）

**影响文件**：`src/storage/repository.ts`, `src/core/gate.ts`, `tests/core.test.ts`
**测试**：54/54 通过

---

### Wave 3 (A4) — gate_start_plan MCP Tool (2026-05-28)
- 创建 `src/tools/startPlan.ts`（`gate_start_plan` MCP Tool 实现）
- Handler 逻辑：校验 title + steps 输入 → 生成 task_id → flattenPlan 展开嵌套 PlanNode → 构建 TaskRow + StepRow[] → generateStepKey 生成首步密钥 → createTask 原子写入 DB → 返回 taskId/status/currentStep/stepKey
- 使用 zod v4 `z.lazy()` 支持递归 PlanNode schema 验证
- step_key 明文仅在此次返回，后续只存 SHA-256 hash
- **测试**：54/54 通过

---

### Wave 3 (A6) — gate_checkpoint MCP Tool (2026-05-28)
- 创建 `src/tools/checkpoint.ts`（`gate_checkpoint` MCP Tool 实现）
- Handler 逻辑：调用 `validateCheckpoint(repo, taskId, stepId, stepKey)` 5 步校验 → `advanceStep(repo, task, currentStep)` 推进状态机 → 返回普通步骤（nextStep + nextStepKey）或最终步骤（allStepsCompleted + finalKey）
- GateError 捕获后返回 `accepted: false` + 错误码及可选的 currentStep 信息；未知错误返回 `INTERNAL_ERROR`
- 确认 `repository.ts` 导出的所有函数完全满足 `GateRepository` 接口（getTask, getCurrentStep, getTaskSteps, completeAndAdvance, updateTaskStatus, verifyFinalKey）
- MCP Tool 注册：Zod schema 校验 `taskId/stepId/stepKey`，返回 `CallToolResult` 包装的 JSON 输出
- **测试**：54/54 通过

---

### Wave 3 (A5) — gate_current MCP Tool (2026-05-28)
- 创建 `src/tools/current.ts`（`gate_current` MCP Tool 实现）
- Handler 逻辑：`getTask(taskId)` 查询任务 → 不存在返回 `not_found` → `getCurrentStep(taskId)` 查当前步骤 → 无当前步骤返回 status + null → 有当前步骤返回 stepId/path/index/total
- **安全设计**：不返回 `step_key` 明文。step_key 只在 `gate_start_plan` 创建时返回一次，之后只能通过 `gate_checkpoint` 获取下一步的新 key
- 使用 zod v4 进行输入参数校验（taskId: string），MCP SDK 1.29.0 `server.tool()` 注册
- **测试**：54/54 通过

---

### Wave 3 (A7) — gate_finalize MCP Tool (2026-05-28)
- 创建 `src/tools/finalize.ts`（`gate_finalize` MCP Tool 实现）
- Handler 逻辑：
  1. `getTask(taskId)` → 不存在返回 `{ accepted: false, status: 'not_found' }`
  2. 已完成任务幂等返回 `{ accepted: true, status: 'completed' }`（message: "Task was already finalized."）
  3. `verifyFinalKey(taskId, finalKey)` 验证 final_key hash → 失败返回 `{ accepted: false, status: 'active' }` + 可选 currentStep 信息
  4. 验证通过 → `updateTaskStatus(taskId, 'completed')` + `addEvent('task_finalized')` → 返回 `{ accepted: true, status: 'completed' }`
- 使用 zod v4 进行输入参数校验（taskId + finalKey），MCP SDK 1.29.0 `server.registerTool()` 注册
- 添加 zod v4 为项目直接依赖（`package.json`）
- **测试**：54/54 通过（无冲突）

---

### Wave 3 Bug Fix (A8) — 代码审计修复 (2026-05-28)

**严重 1 — finalize.ts 使用错误的 MCP SDK API**
- `server.registerTool()` + `import type { CallToolResult }` 与其他 3 个 Tool 的 `server.tool()` 模式不一致
- **修复**：改为与 checkpoint.ts 一致的 `server.tool(name, desc, schema, handler)` 模式，移除 `CallToolResult` 导入

**严重 2 — startPlan.ts 使用不存在类型 `z.$ZodType`**
- `const stepNodeSchema: z.$ZodType = z.lazy(...)` — `$ZodType` 在 Zod v4 中不存在
- **修复**：删除 `: z.$ZodType` 类型注解，让 TypeScript 自动推断

**严重 3 — current.ts 的 Zod import 路径错误**
- `import * as z from 'zod/v4'` 导致 `z.z.string()` 而非 `z.string()`
- **修复**：改为 `import { z } from 'zod'`

**建议 1 — startPlan.ts 空输入校验改用结构化错误**
- `throw new GateError(...)` 与其他 Tool 不一致
- **修复**：改为返回 `{ content: [...], isError: true }` 结构化错误

**建议 2 — finalize.ts 添加 isError 标记**
- 当 `accepted: false` 时不设置 `isError: true`，MCP 客户端依赖此标记
- **修复**：添加 `isError: !output.accepted`

**建议 3 — finalize.ts pretty-print 不一致**
- `JSON.stringify(output, null, 2)` 与其他 Tool 的 `JSON.stringify(output)` 不一致
- **修复**：改为 `JSON.stringify(output)`

**建议 4 — design.md 自相矛盾**
- 第 2.2 节 `gate_current` 输出描述前后矛盾（line 27 说返回 step_key，line 28 说不返回）
- **修复**：统一为不返回 step_key，与实际实现一致

**影响文件**：`src/tools/startPlan.ts`, `src/tools/current.ts`, `src/tools/finalize.ts`, `openspec/changes/phase-1-mvp-core/design.md`
**测试**：54/54 通过

---

### Wave 4 (A8) — MCP Server 主入口 (2026-05-28)
- 创建 `src/index.ts`（MCP Server 主入口文件）
  - 使用 `@modelcontextprotocol/sdk` v1.x 的 `McpServer` 和 `StdioServerTransport`
  - 注册 4 个 MCP Tool：`registerStartPlan`, `registerCurrent`, `registerCheckpoint`, `registerFinalize`
  - `McpServer` 构造函数接受 `Implementation` 类型对象（name + version），与 SDK 实际 API 一致
  - `server.connect(transport)` 返回 `Promise<void>`，使用 `await` 处理
- 创建 `src/tools/index.ts`（barrel 文件，统一导出 4 个 Tool 的 register 函数）
- **SDK API 确认**：`McpServer` constructor 签名 `(serverInfo: Implementation, options?: ServerOptions)`；`connect(transport: Transport): Promise<void>`
- **测试**：54/54 通过，TypeScript 零错误

---

### Wave 5 (A10) — README 文档和示例文件 (2026-05-28)
- 创建 `README.md`（项目概述、安装说明、MCP 配置、4 个 Tool 简介、错误码、Prompt 注入文案、技术栈）
- 创建 `examples/simple-plan.json`（6 步平铺计划示例）
- 创建 `examples/nested-plan.json`（3 阶段嵌套计划示例，含 children）
- 创建 `examples/prompt-injection.md`（Agent system prompt 注入文案，含 6 条规则和违规处理说明）
- 创建 `examples/hook-stop-example.sh`（Stop Hook 示例脚本，通过 TASK_ID/FINAL_KEY 环境变量调用 gate_finalize 校验）

---

### Wave 5 (A9) — 端到端集成测试 (2026-05-28)
- 创建 `tests/tools.test.ts`（22 个集成测试，直接调用 repository + core 函数模拟 4-Tool 完整流程）
- **End-to-End: Simple Plan** (2 tests)
  - 3 步平铺计划从 start → checkpoint × 3 → finalize 完整生命周期
  - 单步计划直接获得 final_key
- **End-to-End: Nested Plan** (1 test)
  - 2 层嵌套计划（Phase 1/Phase 2）flatten 为 3 个叶子步骤并完整走通
- **Checkpoint Validation** (5 tests)
  - 跳步拒绝（INVALID_CURRENT_STEP）
  - 旧 key 重用拒绝（step key 一次性消费后无法再用）
  - 错误 step key 拒绝（INVALID_STEP_KEY）
  - 不存在的 taskId（TASK_NOT_FOUND）
  - 已完成任务拒绝（TASK_ALREADY_COMPLETED）
- **Finalize Validation** (5 tests)
  - 错误 final_key 拒绝
  - 未完成所有步骤时 final_key_hash 为 null
  - 正确 final_key 接受并 transition 到 completed
  - 已完成任务幂等查询
  - 部分完成时返回 currentStep 信息
- **Persistence** (2 tests)
  - 数据重新查询保持状态（step status 变化、key hash 消费）
  - 完整生命周期事件记录（step_completed / step_activated / all_steps_completed / task_finalized）
- **gate_current 模拟** (4 tests)
  - 不存在的 task 返回 undefined
  - 活跃 task 返回 current step 信息
  - 全部完成后 current step 为 undefined
  - finalize 后 task status 为 completed
- **Error handling** (3 tests)
  - 空 taskId → TASK_NOT_FOUND
  - 空 steps → NO_STEPS
  - 空 PlanNode[] → PLAN_SCHEMA_INVALID
- 使用 `beforeEach` 清理单例 SQLite 数据库，每个测试使用唯一 `randomUUID()` taskId
- 辅助函数 `simulateStartPlan()` 封装 `flattenPlan` + `generateStepKey` + `createTask` 流程
- **测试**：76/76 通过（30 core + 24 storage + 22 tools）

---

### Feature — 新密钥格式 + gate_active_task + 集成测试更新 (2026-05-29)

**改动 1 — 新密钥格式**
- `src/core/keys.ts`：将 `sg_step_<64 hex>` / `sg_final_<64 hex>` 格式改为纯 6 位大写字母+数字 (`[A-Z0-9]{6}`)
- 示例格式：`A3K9X2`、`Z7MPQ1`
- 新增 `CHARSET` 常量和 `randomCode(length)` 内部辅助函数
- `hashKey` 导出不变，SHA-256 hash 不变
- `generateStepKey` / `generateFinalKey` 签名不变，仅 plaintext 格式变化

**改动 2 — repository 加 `getActiveTask`**
- `src/storage/repository.ts`：新增 `getActiveTask()` 函数，查询 `status = 'active'` 的第一个 task
- 用于 Stop Hook 快速判断是否有进行中的 step-gated 任务

**改动 3 — 新 MCP Tool `gate_active_task`**
- 创建 `src/tools/activeTask.ts`：`gate_active_task` MCP Tool
- 无参数，调用 `getActiveTask()` + `getCurrentStep(taskId)` 返回 `{ hasActiveTask, taskId?, currentStep? }`
- Stop Hook 以此判断是否需要调用 `gate_finalize`

**改动 4 — Tool 注册**
- `src/tools/index.ts`：新增 `registerActiveTask` 导出
- `src/index.ts`：导入并注册 `registerActiveTask(server)`

**改动 5 — 测试更新**
- 所有测试文件（core / storage / tools / ci-blackbox）中的 key 格式断言从 `sg_step_`/`sg_final_` 改为 `[A-Z0-9]{6}`
- CI 黑盒测试中 mock 错误 key 从 72 字符前缀格式改为 6 字符 `'BADKEY'`
- CI 工具列表测试从 4 工具更新为 5 工具（含 `gate_active_task`）
- 测试描述文字同步更新

**验证**
- `npx tsc --noEmit`：零错误
- `npx vitest run`：91/91 全部通过（30 core + 24 storage + 22 tools + 15 CI blackbox）

---

### Bug Fix — 测试中硬编码 'step_N' ID 适配新 ID 格式 (2026-05-29)

**问题**：`src/core/plan.ts` 已将 auto-generated step ID 格式从 `step_${counter}` 改为 `${taskId}_step_${counter}`，确保多任务不冲突。但 `tests/tools.test.ts` 和 `tests/core.test.ts` 中所有硬编码 `'step_1'` / `'step_2'` / `'step_3'` 等字面量未同步更新，导致测试失败。

**修复**：
- `tests/tools.test.ts`：所有 `'step_N'` 硬编码替换为 `steps[N-1].id`（从 `simulateStartPlan` 返回值获取实际 ID）
  - 新增 `firstStepId` 解构用于首步断言
  - `stepKeys['step_N']` 替换为 `stepKeys[steps[N-1].id]`
  - `nextStepKeys!['step_N']` 替换为 `nextStepKeys![steps[N-1].id]`
- `tests/core.test.ts`：flattenPlan auto-serial 测试的 ID 断言从 `.toBe('step_N')` 改为 `.toMatch(/_step_N$/)`；dependsOn 断言从 `toEqual(['step_N'])` 改为 `toEqual([result[N-1].id])`

**影响文件**：`tests/tools.test.ts`, `tests/core.test.ts`
**测试**：110/110 全部通过（36 core + 34 storage + 25 tools + 15 CI blackbox）
