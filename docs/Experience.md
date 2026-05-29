# Experience — 踩坑经验

> 每条经验 = 问题 + 原因 + 解决方案 + 日期。按时间倒序排列。

## 2026-05-28

### 项目初始化
- **事件**：项目启动，CodeGraph 初始化完成
- **经验**：项目目录为空时 CodeGraph init 会给出 "No files found to index" 警告，正常现象

---

## 2026-05-28 (Bug Fix A3 — 事务保护)

### 多步 DB 操作必须使用事务，否则崩溃会导致数据不一致
- **问题**：`advanceStep` 原来分 3 次独立 DB 调用（completeStep, setCurrentStep, addEvent），如果进程在第 1 和第 2 次调用之间崩溃，step 已被标记 completed 但下一步未激活，task 永久僵死
- **解决方案**：使用 better-sqlite3 的 `db.transaction()` 将所有写操作包装在一个原子事务中。事务要么全部成功，要么全部回滚，杜绝中间态
- **踩坑人**：Bug Fix Agent (A3)

### GateRepository 接口应覆盖所有 repo 层暴露的方法
- **问题**：`updateTaskStatus` 和 `verifyFinalKey` 已在 `repository.ts` 中实现，但未在 `gate.ts` 的 `GateRepository` 接口中声明，导致 Wave 3 工具无法通过接口调用这些方法
- **解决方案**：在接口中补齐缺少的方法签名。接口和实现应保持同步
- **踩坑人**：Bug Fix Agent (A3)

---

## 2026-05-29

### 新密钥格式迁移（sg_step_/sg_final_ 前缀 → 纯 6 位 [A-Z0-9]{6}）
- **事件**：将 step key 和 final key 从 `sg_step_<64 hex>` 格式改为 6 位大写字母+数字 code
- **经验**：key 格式变更时，需注意区分两类测试断言：(1) 格式断言（regex 匹配 "key 长什么样"）— 必须同步更新；(2) 测试数据字符串（mock key 用于验证 checker logic）— 格式无关，因为 `validateCheckpoint` 只比 hash，不关心 plaintext 格式。但为代码可读性，mock key 也应更新为新格式避免后来者困惑
- **影响范围**：keys.ts 是唯一生成者；gate.ts 只调 generate/hash，不关心格式；测试文件的 key 校验 regex 需全面更新
- **踩坑人**：Code Agent (2026-05-29 Wave)

### gate_active_task — Stop Hook 集成点
- **事件**：新增 `gate_active_task` MCP Tool，供 Stop Hook 判断是否有进行中的 step-gated 任务
- **经验**：该 Tool 无参数、无副作用，仅读取。Stop Hook 的典型用法：
  1. 调用 `gate_active_task` → `hasActiveTask: false` → 不需要 gate_finalize，普通退出
  2. `hasActiveTask: true` → 读取 `taskId` → 再调用 `gate_current` 获取完整状态 → 决定是否需要 finalize
- **踩坑人**：Code Agent (2026-05-29 Wave)

## 通用 / 架构

### better-sqlite3 SELECT * 返回蛇形列名，必须手动映射驼峰 (2026-05-28)
- **问题**：better-sqlite3 的 `SELECT *` 返回的行对象，列名与建表语句中的列名完全一致（蛇形 snake_case）。直接用 `as CamelType` 强制转换不会自动映射，导致读到的属性全是 `undefined`
- **解决方案**：在 repository 层添加映射函数（`mapTaskRow` / `mapStepRow` / `mapEventRow`），每个查询函数返回前调用映射。注意：`INSERT`/`UPDATE` 使用命名参数时不受影响（参数名由调用者控制）
- **踩坑人**：A2 Bug Fix Agent

## 测试 / CI

### CI 黑盒测试完成 — 全部 91 个测试通过 (2026-05-28)
- **测试文件**: `tests/ci-blackbox.test.ts` (15 个 MCP 协议级黑盒测试)
- **方法**: spawn `node dist/index.js`, 通过 stdin/stdout 发送 JSON-RPC 消息, 严格黑盒
- **结果**: 15/15 黑盒测试通过, 所有 4 个现有测试文件也通过, 总计 91 个测试全部通过

#### CI 发现的 Spec 缺口

1. **响应字段蛇形 vs 驼峰**: design.md 所有字段使用 snake_case (task_id, step_key, current_step), 但服务器实际返回 camelCase (taskId, stepKey, currentStep)。输入参数也使用 camelCase。建议统一: 要么更新 design.md, 要么在实现层做映射。

2. **currentStep.stepId 返回 UUID**: design.md 2.1 暗示 current_step.step_id 对应用户输入的 step_id, 但服务器实际返回内部生成的 UUID。这意味着 gate_checkpoint 的 step_id 参数也需要传这个 UUID, 而非用户原始 step_id。

3. **gate_current 不存在的 task 返回 { status: "not_found", currentStep: null }**: 未设置 isError 标志, 行为与设计规格的不完全一致(设计说应该报 TASK_NOT_FOUND 错误)。不过返回格式清晰, 客户端可以通过 status 字段判断。

4. **错误码未在 tool 响应的 JSON 体中暴露**: gate_finalize 等失败时返回 `accepted: false` 和 `isError: true`, 但具体的 errorCode 字符串(如 INVALID_FINAL_KEY)未在 content[0].text 的 JSON 中返回, 只在顶层的 MCP response 的 isError 中体现。

#### 验证通过的功能

- 4 个 MCP Tool 全部可用: gate_start_plan, gate_current, gate_checkpoint, gate_finalize
- MCP 协议: initialize -> initialized notification -> tools/list -> tools/call 正常
- 嵌套计划 DFS flatten (leaf nodes only) 正确
- Step key 格式: sg_step_<64 hex>, 一次性使用
- Final key 格式: sg_final_<64 hex>
- gate_current 查询不泄露 stepKey
- 跳步 checkpoint 被拒绝 (INVALID_CURRENT_STEP)
- 过期 key 复用被拒绝 (INVALID_STEP_KEY)
- 错误 final_key 被拒绝
- 正确 finalKey 可完成 finalize (status -> completed)
- 已完成任务的 checkpoint 被拒绝
- 空步骤计划被拒绝
- 缺失必填参数被 Zod schema 校验拒绝

## 工具链

### Zod v4 import 路径: 必须用 `import { z } from 'zod'` (2026-05-28)
- **问题**：`import * as z from 'zod/v4'` 导致调用签名变成 `z.z.string()` 而非 `z.string()`。Zod v4 的 `/v4` 子路径导出的是整个模块 as namespace，与 `import { z } from 'zod'` 的行为不同。checkpoint.ts 和 startPlan.ts 都使用 `import { z } from 'zod'`，唯独 current.ts 用了错误路径
- **解决方案**：统一使用 `import { z } from 'zod'`。这是 Zod v4 推荐的 import 方式
- **踩坑人**：Bug Fix Agent (A8)

### Zod v4 不存在 `$ZodType` 类型 (2026-05-28)
- **问题**：`const stepNodeSchema: z.$ZodType = z.lazy(...)` 中 `$ZodType` 在 Zod v4 中不存在，导致 TypeScript 编译错误
- **解决方案**：删除类型注解，让 TypeScript 自动推断 `z.lazy()` 的返回类型。在 Zod v4 中，lazy 类型的内部表示已改变，不应手动注解
- **踩坑人**：Bug Fix Agent (A8)

### MCP SDK: `server.tool()` vs `server.registerTool()` (2026-05-28)
- **问题**：`gate_finalize` 使用了 `server.registerTool()` + `CallToolResult` 导入，而其他 3 个 Tool 都使用 `server.tool()`。API 不一致会导致维护困难和潜在的运行时行为差异
- **解决方案**：统一使用 `server.tool(name, desc, schema, handler)` 模式（checkpoint.ts 为黄金标准）。`server.tool()` 自动处理 Zod schema 到 JSON schema 的转换，更简洁
- **踩坑人**：Bug Fix Agent (A8)

### MCP Tool 返回必须设置 `isError` 标记 (2026-05-28)
- **问题**：`gate_finalize` 在 `accepted: false` 时不设置 `isError: true`，MCP 客户端依赖此标记判断工具调用是否成功
- **解决方案**：所有 Tool 统一在返回中添加 `isError: !output.accepted`（或等效逻辑），参照 checkpoint.ts 的模式
- **踩坑人**：Bug Fix Agent (A8)

### 输入校验应返回结构化错误而非 throw (2026-05-28)
- **问题**：`gate_start_plan` 在输入校验失败时直接 `throw new GateError(...)`，格式与其他 Tool 的 `{ content: [...], isError: true }` 不一致
- **解决方案**：输入校验失败时返回结构化错误对象，保持所有 Tool 的错误格式一致
- **踩坑人**：Bug Fix Agent (A8)
