# Step Gate 安全压力测试报告

**日期**: 2026-05-30
**测试环境**: Windows 11, Node.js 20+, SQLite WAL
**测试方法**: 黑盒 CLI 端到端，所有漏洞均实际复现
**状态**: 持续更新中，部分条目已讨论定论

---

## 漏洞总览

| 编号  | 问题                    | 当前判定    | 状态           |
| --- | --------------------- | ------- | ------------ |
| A1  | 跨 Session 取消他人 Task   | 🔴 确认漏洞 | ✅ 已修复        |
| A2  | 跨 Session Checkpoint  | ✅ 非漏洞   | 已定论，关闭       |
| A3  | 跨 Session Finalize    | ✅ 非漏洞   | 已定论，关闭       |
| B1  | skipKey 无限复用          | 🔴 确认漏洞 | ✅ 已修复        |
| B2  | 已取消 Task 的 skipKey 复用 | ✅ 按设计   | 已定论，关闭       |
| F1  | 循环依赖死锁                | 🔴 确认漏洞 | ✅ 已修复        |
| F3b | 父级 dependsOn 静默丢弃     | 🔴 确认漏洞 | ✅ 已修复        |
| D1  | 无暴力破解防护               | ✅ 不接受   | 已定论，关闭       |
| C2  | 并行分支理论死锁窗口            | ⚪ 不再适用  | 已定论，关闭（Skill+CLI 模式） |
| H5  | --commit-parent 静默忽略  | 🟡 中危   | ⚪ 不再适用（架构变更） |

---

## 🔴 确认漏洞（已定论）

### A1 — 跨 Session 取消他人 Task

**复现步骤**:
```bash
# Session A 创建 task
start-plan '{"title":"压力测试目标App","steps":[...]}'
# → taskId: tsk_TPII9N, sessionId: ses_IV84ZL

# 清除 session 文件，模拟 Session B
rm .step-gate/sessions/*.json .step-gate/bindings/*.json

# Session B 直接取消 Session A 的 task
cancel-task '{"taskId":"tsk_TPII9N"}'
# → {"ok":true,"message":"Task cancelled."}
```

**根因**: `cmdCancelTask()` (`src/cli.ts:365`) 仅检查 `task.status !== 'active'`，不校验 session_id。

**真实危害**:
Agent 可能因幻觉随意取消 task。场景：
1. Session A 执行 Phase 1，Agent 幻觉调了 `cancel-task` 取消了 Session B 正在执行的 task
2. Session B 缺少上下文，不知道自己被取消了，继续执行
3. Session B 后续的 checkpoint 全部失败（task 已取消），key 无法验证，**永久死锁**

**定论**: 破坏性操作必须有 session 门控。Agent 自己取消自己的 task 合理，跨 session 取消是越权。

**修改方向**:
1. `cancel-task` 强制校验 session_id，只能取消当前 session 创建的 task
2. `cancelTask()` 仓库函数增加 `sessionId` 参数
3. 跨 session 管理能力保留给 `--admin` + recoveryToken 认证路径

---

### B1 — skipKey 无限复用

**复现步骤**:
```bash
# 源 task tsk_41MV33，auth 步骤已完成，key: TAUXI9，task 已取消

# 第一次使用 skipKey → 成功
start-plan '{"title":"重建v1","steps":[
  {"id":"auth","dependsOn":[],"skipKey":"TAUXI9","skipTaskId":"tsk_41MV33"},
  {"id":"api","dependsOn":["auth"]}
]}'
# → ok, taskId: tsk_HA1JC1, auth 自动 completed

# 第二次使用同一 skipKey → 仍然成功！
start-plan '{"title":"重建v2-重复用skipKey","steps":[
  {"id":"auth","dependsOn":[],"skipKey":"TAUXI9","skipTaskId":"tsk_41MV33"},
  {"id":"api","dependsOn":["auth"]}
]}'
# → ok, taskId: tsk_4CZHMX, auth 再次自动 completed
```

**根因**（代码级）:

`verifySkipKey()` (`src/storage/repository.ts:478`) 是**纯读操作**：
```typescript
// 只有 SELECT，没有任何写入
const step = db.prepare(
  "SELECT step_key_hash, status FROM steps WHERE task_id = ? AND id = ?"
).get(oldTaskId, stepId);
// 验证通过 → 返回 true
// 旧记录无任何消费标记！
```

`cmdStartPlan()` (`src/cli.ts:146-161`) 验证通过后直接建新 task：
```typescript
// 旧 task 的 step 仍然是 status='completed', step_key_hash 不变
// 新 task A 建表时 auth 标记 completed
// 新 task B 再来时，旧 step 的 hash 仍然匹配 → 再次通过
```

链条：`verifySkipKey 只读 → 旧记录不变 → 新 task 无感知 → 无限复用`

**定论**: skipKey 应一次性消费。当前实现把 skip 直接坍缩成 `completed`，凭证溯源丢失。

**修改方向**（已讨论通过）:
1. 旧 step 增加消费标记：`events` 表记录 `skip_key_consumed` 事件，verify 时检查是否已被消费
2. 新 task 中 skip 的步骤不标记为 `completed`，改为新状态 `skipped`——保留凭证溯源
3. DAG 解锁到 `skipped` 步骤时，自动跳过并立即分发下一步 key（与 checkpoint 行为一致，Agent 感知"这一步已验证跳过，直接进入下一步"）

---

## ✅ 非漏洞（已定论关闭）

### A2 — 跨 Session Checkpoint（关闭）

**测试现象**: Session B 用已知 key 成功 checkpoint Session A 的步骤。

**定论**: **不是漏洞**。理由：
1. stepKey 由 `crypto.randomBytes` 真随机生成 → Agent 幻觉永远猜不中
2. `current` / `active-task` 命令不返回 key → 上下文丢失也找不回
3. key 只在 `start-plan` / `checkpoint` 返回值中出现一次，不落盘
4. 唯一获取途径是终端输出——如果另一个 Session 能拿到 key，说明是用户主动协作传递
5. 在 Program 模型下，Session A 做 Phase A、Session B 做 Phase B，key 天然隔离，不存在跨 Session 操作通道

**结论**: key 校验本身就是充分的防护，不做 session 绑定。

---

### A3 — 跨 Session Finalize（关闭）

**测试现象**: Session B 用 finalKey 成功 finalize Session A 的 task。

**定论**: **不是漏洞**。理由同 A2——finalKey 同样是真随机、单次返回、不落盘、不暴露。能拿到 finalKey 的只有亲眼看到终端输出的人，属于协作而非越权。

---

## 🔴 确认漏洞（已修复 / 已关闭）

### B2 — 已取消 Task 的完成步骤可作 skipKey

**复现步骤**:
```bash
# 创建 task，完成 auth+db，取消 task
start-plan → checkpoint auth → checkpoint db → cancel-task

# 用已取消 task 的 auth key 作为 skipKey 重建
start-plan '{"steps":[
  {"id":"auth","skipKey":"TAUXI9","skipTaskId":"tsk_41MV33",...}
]}'
# → 验证通过
```

**根因**: `verifySkipKey` 只检查 step 的 `status='completed'`，不检查父 task 状态。

**定论** (2026-05-30): **按设计工作，关闭**。

理由：
1. A1 已修：Agent 只能取消自己的 Task，不能越权取消
2. B1 已修：每个 skipKey 一次性消费，无法无限复制
3. Step 原子化：Step 的 completed 状态是客观事实，不随 Task 容器销毁而改变
4. 重建合法性：Agent 看 Step title/path 判断是否等价，这正是 `rebuild` 工作流的设计意图

取消的 Task 的已完步作为 skipKey 来源，与正常 Task 的 skipKey 来源无本质区别——两者都是"这个 Step 客观已做完"的密码学证明。

---

### F1 — 循环依赖导致永久死锁

**复现步骤**:
```bash
start-plan '{"title":"循环依赖","steps":[
  {"id":"a","dependsOn":["c"]},
  {"id":"b","dependsOn":["a"]},
  {"id":"c","dependsOn":["b"]}
]}'
# → currentSteps: [], stepKeys: {}
# → 3 步全 pending，无一可启动，永久死锁
```

**根因**: `flattenPlan()` 不检测循环依赖。

**修复** (2026-05-30):
1. Phase 2: 将 node ID 依赖解析为 leaf step ID 依赖（含容器展开）
2. Phase 3: DFS 三色标记检测环路，GRAY 回边 = 循环，抛出 `PLAN_SCHEMA_INVALID`
3. 支持自引用、直接循环、通过容器的间接循环
4. 容器引用展开：`dependsOn:["container"]` 展开为所有后代 leaf step

---

### F3b — 父级 dependsOn 被静默丢弃

**复现步骤**:
```bash
start-plan '{"title":"父级依赖传播","steps":[
  {"id":"parent","dependsOn":["other"],"children":[
    {"id":"c1","dependsOn":[]},
    {"id":"c2","dependsOn":[]}
  ]},
  {"id":"other","dependsOn":[]}
]}'
# → currentSteps: [c1, c2, other]  ← c1,c2 没等 other！
```

**根因**: `flattenPlan` 展开 children 时，父节点的 `dependsOn` 不传递给子节点。容器展开后依赖丢失。

**修复** (2026-05-30):
1. DFS flatten 增加 `inheritedDependsOn` 参数，沿途累积祖先的 dependsOn
2. 每个 leaf 的 effective dependsOn = 继承的 + 自己的（去重）
3. 多层级嵌套正确累积所有祖先依赖
4. 父节点 `dependsOn: []` 不影响子节点 auto-serial 行为

---

## 🟡 低优先级（已定论）

### D1 — 无暴力破解防护（关闭）

10 次错误 key 全部返回 `INVALID_STEP_KEY`，无冷却/锁定。6 位 key (36^6 ≈ 2.1B) 在无速率限制下可被暴力枚举。

**定论** (2026-05-30): **不接受，关闭**。

理由：本工具不是安全防御产品。Key 的目的是防止 Agent 幻觉/上下文丢失导致误操作，不是对抗恶意攻击。Agent 非刻意攻击场景下，猜中 Key 的概率 ≈ 0。2.1B 的搜索空间对偶尔的错误尝试已足够。

### C2 — 并行分支理论死锁窗口（不再适用，关闭）

**原场景**（MCP Server 模式）：DAG 中两个并行分支 modA、modB 汇合到 integrate，两个 Agent 同时调 `gate_checkpoint` tool，并发读 DB 导致各自看到对方的旧状态，汇合点永不激活。

**为什么 Skill+CLI 模式下不存在**：

Skill+CLI 架构中，Main Agent 是**所有 CLI 调用的单点串行调度者**：

```
Sub Agent A 回报 stepKey
  → Main Agent: step-gate checkpoint A    ← 独立进程，独占用 DB
    → 返回（B 已解锁）
      → Main Agent 派发 Sub Agent B
        ...几十秒后...
          → Main Agent: step-gate checkpoint B  ← 另一个独立进程，必然看到 A 的写入
```

两次 checkpoint 之间隔着 Main Agent 的解析、决策、派发、Sub Agent 执行——不可能在微秒级并发。C2 并发窗口的前提（MCP Server 常驻进程 + 多 Agent 直连 tool）在 Skill+CLI 模式下根本不存在。

**定论**: 架构变更后不再适用，关闭。

### H5 — --commit-parent 无 Program 绑定时静默忽略（不再适用）

`finalize --commit-parent` 在 session 无 program 绑定时不报错，Agent 可能误以为已成功级联。

**定论**: 架构变更后不再适用。`--commit-parent` 标志已被移除，auto-propagation 在 `finalize` 时自动触发。Session 无 program 绑定时，`commitProgramNode()` 返回 null，finalize 仅完成任务级别，行为正确。

---

## 附录：测试覆盖

| 命令 | 测试次数 | 发现漏洞 |
|------|---------|---------|
| `start-plan` | 15+ | F1, F3b, B1, B2 |
| `checkpoint` | 30+ | A2, C1, C2, D1 |
| `finalize` | 8+ | A3, H1, H5 |
| `cancel-task` | 6+ | A1, H3 |
| `current` | 5+ | — |
| `program init/start` | 3+ | H4 |
| `active-task` | 3+ | — |

**总计**: 70+ 次 CLI 调用，8 个子 Agent 空转，零文件变更。
