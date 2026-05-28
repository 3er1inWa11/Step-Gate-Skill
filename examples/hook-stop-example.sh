#!/bin/bash
# Stop Hook 示例 — 在 Agent 停止前校验 final_key
#
# 使用方式：
#   将此脚本配置为 Claude Code 的 Stop Hook
#   或通过环境变量 TASK_ID / FINAL_KEY 调用

TASK_ID="${TASK_ID:-}"
FINAL_KEY="${FINAL_KEY:-}"

if [ -z "$TASK_ID" ]; then
  echo "No TASK_ID set, allowing stop."
  exit 0
fi

# 调用 MCP Server 的 gate_finalize
# 注意：实际调用方式取决于你的 MCP 客户端实现
RESULT=$(echo "{\"task_id\":\"$TASK_ID\",\"final_key\":\"$FINAL_KEY\"}" | \
  # 你的 MCP 调用方式
  # 示例：curl 或其他方式调用 MCP tool
)

# 检查结果中的 accepted 字段
if echo "$RESULT" | grep -q '"accepted":true'; then
  echo "Step Gate: All steps completed. Task can finish."
  exit 0
else
  echo "Step Gate: Task cannot finish!"
  echo "Some steps are not checkpointed. Please return to the current step."
  echo "Result: $RESULT"
  exit 1
fi
