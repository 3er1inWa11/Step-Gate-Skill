# Agent Step Gate MCP Server

## 项目概述

轻量 MCP Server，保证长程 Agent 任务中计划步骤不被遗漏。核心定位：**Step Ledger + Key Gate**。

## 开发流程（7 步闭环）

### Step 1 — OpenSpec 先行
- 创建 `openspec/changes/<phase-name>/` 目录
- 写 `proposal.md`（Why / What Changes / 核心不变）
- 写 `tasks.md`（任务清单，勾选追踪）
- 需要时写 `design.md`

### Step 2 — CodeGraph 探查
- 派 Explore 子 Agent 用 CodeGraph 摸清影响范围
- 确认文件存在/新建/依赖关系
- 输出影响分析报告

### Step 3 — SDD 分批派发（每 Wave）
- 每波 Agent 全部并行（确保文件不冲突）
- 每个 Agent 启动前必须验证 `AGENT_PLAYBOOK.md` + `Experience.md` 存在，否则拒绝执行
- 每个 Agent 必须写单元测试 + 更新 `NEWSYSEMLOG.md`
- Agent 完工后不立即解散，等 CI 反馈

### Step 4 — CI Agent 黑盒验证
- CI Agent 只能读 `openspec/specs/` + `design.md`，绝对禁止读源码
- CI Agent 写黑盒测试文件
- CI Agent 更新 `Experience.md`

### Step 5 — 执行 CI 测试
- 启动服务
- 跑 CI 测试
- 有 Bug → 谁的功能谁修 → 修完沉淀经验到 Experience.md
- 全部通过 → 该 Wave 收工

### Step 6 — 文档闭环
- `NEWSYSEMLOG.md` — 每笔改动记录
- `Experience.md` — 每条踩坑经验
- `tasks.md` — 全部勾选

### Step 7 — Phase 完成
- `openspec/specs/` 同步 delta specs
- 确认 tasks.md 全部勾选
- 下一 Phase 开工前检查上一 Phase 文档完整性

## 角色分工

- **Main Agent**：只负责决策讨论、任务派发、进度追踪，不写代码不调试
- **Code Agent**：执行具体编程任务，写源码 + 单元测试
- **CI Agent**：黑盒功能测试，只读 spec 不读源码
- **Review Agent**：代码审计

## 每 Wave 完成后硬性检查

1. **代码审计** — Spawn 独立 Agent 执行 code review
2. **CI 黑盒功能测试** — Spawn 独立 Agent，严格黑盒

## CodeGraph

本项目已初始化 CodeGraph 索引。CodeGraph 是代码查询的首选工具。

### 刚性规则

1. 所有 CodeGraph 调用必须带 `projectPath: "D:\\StepLeader"`
2. 禁止在主会话中调用 `codegraph_explore` 和 `codegraph_context`
3. 优先 CodeGraph 而非 grep/Read 进行结构化查询

## 技术栈

- Runtime: Node.js 20+
- Language: TypeScript
- MCP SDK: @modelcontextprotocol/sdk
- Storage: SQLite (better-sqlite3)
- Package: pnpm
- Test: vitest
