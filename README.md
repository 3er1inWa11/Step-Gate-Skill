# Agent Step Gate MCP Server

轻量 MCP Server，保证长程 Agent 任务中计划步骤不被遗漏。

**核心原则**：相信 Agent 的能力，但不相信 Agent 的完成说辞。

## 做什么

- 注册嵌套步骤计划，自动 flatten 成 leaf step 执行序列
- 为每个步骤发放一次性密钥
- 按序 checkpoint 步骤，不可跳步、不可重用旧 key
- 全部步骤完成后发放 final_key
- Stop Hook 用 final_key 校验任务是否真的完成

## 不做什么

- 不做质量检查
- 不做 DAG / 多人协作
- 不做复杂审批
- 不做每次工具调用拦截

## 安装

```bash
git clone <repo-url>
cd agent-step-gate
pnpm install
pnpm build
```

## MCP 配置

在 Claude Code 的 `.claude/mcp.json` 或 Codex 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agent-step-gate": {
      "command": "node",
      "args": ["D:/StepLeader/dist/index.js"]
    }
  }
}
```

## 4 个 MCP Tool

### gate_start_plan — 创建计划
输入嵌套步骤，返回第一个 step 和 step_key。

### gate_current — 查询当前步骤
不返回 step_key（安全设计）。

### gate_checkpoint — 完成当前步骤
返回下一步和新 step_key（或 final_key）。

### gate_finalize — 最终校验
用 final_key 确认任务完成。Stop Hook 可调用。

详细 input/output 格式见 design.md。

## 示例

见 `examples/` 目录。

## 错误码

TASK_NOT_FOUND, TASK_ALREADY_COMPLETED, NO_STEPS,
INVALID_CURRENT_STEP, INVALID_STEP_KEY, INVALID_FINAL_KEY,
PLAN_SCHEMA_INVALID, INTERNAL_ERROR

## Prompt 注入文案

在任务开始时注入以下规则到 Agent 的 system prompt：

```
本任务启用了 Step Gate。

规则：
1. 开始后调用 gate_current 获取当前步骤
2. 每完成一个 leaf step 后调用 gate_checkpoint
3. gate_checkpoint 会返回下一步和下一步密钥
4. 只有获得 final_key 后，你才可以声明整个任务完成
5. Step Gate 不评价你的实现质量，只记录步骤是否按顺序经过
```

## 技术栈

TypeScript, @modelcontextprotocol/sdk, better-sqlite3, vitest
