# Agent 协作守则（必读）

> **所有 Agent 启动前必须先读本文 + [Experience.md](Experience.md)。**
> 不读就开工 = 返工。CI Agent 的起步文档在[第五节](#5-ci-agent-专项守则)。

---

## 0. 开工前自检（最高优先级 — 2026-05-27 新增）

> **文档先行，没有文档不动工。这是不可商量的铁律。**

### 每个 Agent 收到任务后，第一步不是写代码，而是检查文档：

```
1. 检查 openspec/changes/<phase-name>/ 目录是否存在
2. 检查 proposal.md 是否存在且完整（Why / What Changes / 核心不变）
3. 检查 tasks.md 是否存在且有明确的任务清单
4. 需要 design.md 的任务 → 检查 design.md 是否存在
5. 以上任一缺失 → 拒绝执行，回报主会话
```

**拒绝执行的标准话术**：
```
BLOCKED: OpenSpec 文档不完整。
缺失项：
- openspec/changes/<phase>/proposal.md — 不存在
- openspec/changes/<phase>/tasks.md — 不存在
请先补齐文档再派发。
```

**为什么**：CI Agent 只读 Spec 文档写测试。文档空 = 测试空 = 系统验证不完整 = 返工。

---

## 1. 必读清单

每个 Agent 被派发后，**在动手写任何代码之前**，必须按顺序阅读：

| 顺序 | 文档 | 理由 |
|------|------|------|
| 0 | **先执行 §0 开工前自检** | 文档不全不执行 |
| 1 | 本文（`docs/AGENT_PLAYBOOK.md`） | 了解协作规则、边界、完工条件 |
| 2 | `Experience.md` | 前人踩过的坑，不要重复犯 |
| 3 | 任务相关的 `docs/modules/` 或 `docs/architecture/` | 理解模块契约和架构约束 |
| 4 | 任务相关的 `backend/domain/` schema 文件 | 对着契约开发，不是对着想象开发 |

**Code Agent（写代码的）** 额外必须读：
- `CLAUDE.md` — 项目架构、开发规范、模块耦合约束

**CI Agent（黑盒测试的）** 额外必须读：
- 本文第五节 — CI 专项守则
- `openspec/specs/` — 功能需求规格

**禁止**：CI Agent 读 `CLAUDE.md`（那里面有架构细节，会污染黑盒视角）。

---

## 2. CodeGraph 使用规则

### 刚性规则

1. **所有 CodeGraph 调用必须带 `projectPath: "D:\\StepLeader"`**，否则报 "not initialized"
2. **禁止在主会话中调用 `codegraph_explore` 和 `codegraph_context`** — 它们返回大量源码，会污染主会话上下文。探索类问题 spawn Explore 子智能体处理
3. **优先 CodeGraph 而非 grep/Read 进行结构化查询** — grep/Read 仅用于：字符串字面量、注释、日志消息等 CodeGraph 无法覆盖的文本查询

### 工具速查

| 问题 | 工具 |
|------|------|
| "X 在哪里定义？" | `codegraph_search` |
| "谁调用了 Y？" | `codegraph_callers` |
| "Y 调用了什么？" | `codegraph_callees` |
| "改 Z 会影响什么？" | `codegraph_impact` |
| "看 X 的签名/源码" | `codegraph_node` |
| "这个目录下有什么？" | `codegraph_files` |
| "索引健康吗？" | `codegraph_status` |

### 工作流

```
codegraph_search 定位 → codegraph_node 看签名 → Read 编辑文件
```

每步数据量可控。每次修改代码后索引会自动同步（已配置 Hook）。

---

## 3. 角色分工（铁律）

```
Code Agent（写代码）              CI Agent（写测试）
──────────────────────────────────────────────────
可以看所有源码                    绝对不能看源码（.py/.tsx/.ts）
写单元测试确保语法逻辑正确          写黑盒测试确保功能正确
自己测自己写的代码                 测所有人的代码
修自己造成的 Bug                  发现 Bug 后反馈，不修
读 CLAUDE.md / Experience.md     读 openspec/specs/ + 本文第五节
用 CodeGraph 探索代码             用 curl/httpx/fetch 调 API
```

### 一句话：Code Agent 管"写对"，CI Agent 管"能用"。

---

## 4. 完工后流程（不可跳过）

```
Agent 完成代码 + 单元测试通过
        ↓
    报告完成，但不解散
        ↓
CI Agent 启动黑盒测试
        ↓
    输出测试报告
        ↓
   ┌─ 全部通过 → CI 写经验 → 该 Phase 完工
   │
   └─ 有失败 → 谁的功能失败谁去修
                ↓
            修完 → CI 重新测试
                ↓
            全部通过 → 修 Bug 的 Agent 写经验（我踩了什么坑）
                ↓
            CI 写经验（我发现了什么缺口）
                ↓
            该 Phase 完工
```

**Agent 完工后不得立即解散。** 必须等 CI 测试报告出来、Bug 修完、经验写完，才能关闭。

---

## 5. CI Agent 专项守则

### 你的起步文档（与 Code Agent 不同）

| 必读 | 禁止读 |
|------|--------|
| 本文（`docs/AGENT_PLAYBOOK.md`） | `CLAUDE.md` |
| `Experience.md`（测试/CI 章节） | 任何 `.py` 文件 |
| `openspec/specs/` — 功能需求规格 | 任何 `.tsx` / `.ts` 文件 |
| `docs/architecture/` — 架构设计文档 | `backend/` 目录下任何源码 |
| OpenAPI / Swagger 文档（自动生成） | `frontend/src/` 目录下任何源码 |

### 测试方法

1. **黑盒唯一** — 从用户/客户端角度测试。不验证内部实现，只验证外部行为
2. **调 API** — 用 `curl` / `httpx` / `fetch` 直接调端点
3. **连 SSE** — 用 `EventSource` 连接 SSE 流
4. **自己写 prompt** — 如果需要输入内容，CI Agent 自己编写测试用的 prompt


### CI 写经验

每次测试完成（无论通过或失败），必须在 `Experience.md` 的「测试 / CI」章节写入：
- 发现了什么功能缺口
- 什么边界条件被遗漏
- 什么测试模式值得重用
- 什么 API 行为与 spec 不一致
