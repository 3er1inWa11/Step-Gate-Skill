#!/usr/bin/env bash
# Agent Step Gate — Stop Hook
# Fires when Agent completes a task and prepares to go idle.
# Checks: are there tasks that should be finalized?

GATE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GATE_DIR"

HAS_ACTIVE=false
BLOCK=false

# 1. Fast path: read state.json
if [ -f .step-gate/state.json ]; then
  if grep -q '"hasActiveTask": *true' .step-gate/state.json 2>/dev/null; then
    HAS_ACTIVE=true
  fi
fi

if [ "$HAS_ACTIVE" = false ]; then
  # Check if this session has a completed node (nodeKey received)
  if [ -f .step-gate/bindings/bind_*.json ] 2>/dev/null; then
    echo '✅ Step Gate: 无活跃 task，可安全退出'
  fi
  exit 0
fi

echo ''
echo '═══════════════════════════════════════════'
echo '🔒 Step Gate Stop Hook'
echo '═══════════════════════════════════════════'
echo ''

# 2. Check each active task via CLI
ACTIVE=$(node dist/cli.js active-task 2>/dev/null)
if echo "$ACTIVE" | grep -q '"activeTasks":\[\]'; then
  echo '✅ 无活跃 task，可安全退出'
  echo ''
  echo '═══════════════════════════════════════════'
  exit 0
fi

# 3. Inspect each active task
echo "$ACTIVE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for t in d.get('activeTasks', []):
    total = t['totalSteps']
    done = t['completedSteps']
    current = t['currentSteps']
    taskId = t['taskId']
    title = t['title']

    if len(current) == 0 and done == total:
        print(f'🚫 阻塞! Task \033[1m{taskId}\033[0m \"{title}\" {done}/{total} 步全部完成但未 Finalize!')
        print(f'   → 请先执行: node dist/cli.js finalize \\'{{\"taskId\":\"{taskId}\",\"taskKey\":\"<你的taskKey>\"}}\\'')
        print(f'   → taskKey 在最后一步 checkpoint 的返回值中')
        print()
        sys.exit(1)
    elif len(current) > 0:
        print(f'⚠️  Task \033[1m{taskId}\033[0m \"{title}\" {done}/{total} 步完成')
        for c in current:
            print(f'   ⏳ {c[\"stepId\"]} [{c[\"index\"]}/{c[\"total\"]}] {c[\"path\"]}')
        print()
" 2>/dev/null

RESULT=$?

echo '💡 完成后执行: node dist/cli.js finalize ...'
echo ''
echo '═══════════════════════════════════════════'

if [ "${STEP_GATE_STRICT:-0}" = "1" ] && [ "$RESULT" != "0" ]; then
  exit 1
fi
exit 0
