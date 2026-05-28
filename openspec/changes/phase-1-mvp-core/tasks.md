# Phase 1 — 任务清单

## Wave 1: 基础设施 (1 agent)

- [ ] **A1** — `package.json`, `tsconfig.json`, `src/types/index.ts`, `src/core/errors.ts`

## Wave 2: 数据层 + 核心逻辑 (2 agents 并行)

- [ ] **A2** — `src/storage/db.ts`, `src/storage/repository.ts`
- [ ] **A3** — `src/core/plan.ts`, `src/core/keys.ts`, `src/core/gate.ts`

## Wave 3: 4 个 MCP Tools (4 agents 并行)

- [ ] **A4** — `src/tools/startPlan.ts`
- [ ] **A5** — `src/tools/current.ts`
- [ ] **A6** — `src/tools/checkpoint.ts`
- [ ] **A7** — `src/tools/finalize.ts`

## Wave 4: 入口串联 (1 agent)

- [ ] **A8** — `src/index.ts`

## Wave 5: 测试 + 文档 (2 agents 并行)

- [ ] **A9** — 单元测试 (`tests/plan.test.ts`, `tests/gate.test.ts`, `tests/tools.test.ts`)
- [ ] **A10** — README.md + examples/

## 每 Wave 完成后

- [ ] 代码审计 (独立 Review Agent)
- [ ] CI 黑盒功能测试 (独立 CI Agent)
- [ ] Bug 修复 + Experience.md 更新
- [ ] NEWSYSEMLOG.md 更新
