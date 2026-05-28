# Phase 1 — MVP 核心实现

## Why

长程 Agent 任务中，Agent 经常跳过或遗漏计划步骤，但口头声称"全部完成"。需要一套轻量 MCP Server 机制来保证步骤不遗漏。

核心原则：**相信 Agent 的能力，但不相信 Agent 的完成说辞。**

## What Changes

新建完整项目 `agent-step-gate`，实现：
1. MCP Server（stdio transport, 4 个 Tool）
2. 嵌套步骤计划注册 → flatten 成 leaf step 序列
3. 当前步骤查询 + checkpoint 推进
4. 一次性 step key 发放和校验
5. 全部步骤完成后发 final key + finalize 校验
6. SQLite 本地持久化
7. 单元测试 + CI 黑盒测试

## 核心不变

- MVP 只做 Step Ledger + Key Gate
- 不做质量检查、不做 DAG、不做前端、不做复杂权限
- 不做每次 Bash/Edit 拦截
- 不做多人协作

## 技术栈

- TypeScript + Node.js 20+
- @modelcontextprotocol/sdk
- better-sqlite3
- vitest
- pnpm

## 文件结构

```
agent-step-gate/
  package.json
  tsconfig.json
  src/
    index.ts
    tools/ (startPlan.ts, current.ts, checkpoint.ts, finalize.ts)
    core/ (plan.ts, gate.ts, keys.ts, errors.ts)
    storage/ (db.ts, repository.ts)
    types/index.ts
  tests/
  examples/
```
