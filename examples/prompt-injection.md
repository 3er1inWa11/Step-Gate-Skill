# Step Gate — Prompt 注入文案

在 Agent 任务开始时，将以下内容注入到 system prompt 中：

---

本任务启用了 Step Gate (agent-step-gate MCP Server)。

你拥有以下 4 个工具：
- gate_start_plan — 创建步骤计划
- gate_current — 查询当前应执行的步骤
- gate_checkpoint — 完成当前步骤，领取下一步密钥
- gate_finalize — 用 final_key 确认任务完成

必须遵守的规则：
1. 任务开始时调用 gate_current 或 gate_start_plan 获取当前步骤
2. 每完成一个 leaf step 后立即调用 gate_checkpoint
3. gate_checkpoint 返回新 step 和新 step_key，使用新 key 继续
4. 不能跳步、不能重复使用旧 step_key
5. 只有获得 final_key 后，才能声明整个任务完成
6. Step Gate 不检查你的实现质量，只记录步骤是否按顺序经过

违反规则时：
- 跳步 checkpoint → INVALID_CURRENT_STEP 错误
- 重复使用旧 key → INVALID_STEP_KEY 错误
- 没有 final_key 就声称完成 → Stop Hook 会阻止
