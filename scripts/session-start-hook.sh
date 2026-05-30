#!/usr/bin/env bash
# Agent Step Gate — SessionStart Hook
# Lightweight: reads data/state.json first (1ms), falls back to CLI.

echo '═══════════════════════════════════════════'
echo '🔒 Step Gate Session Start'
echo '═══════════════════════════════════════════'
echo ''

HAS_ACTIVE=false

# 1. Fast path: read state file (written by CLI on state changes)
if [ -f data/state.json ]; then
  if grep -q '"hasActiveTask": *true' data/state.json 2>/dev/null; then
    HAS_ACTIVE=true
    echo '⚠️  当前有未完成的 Step Gate 计划:'
    python3 -c "
import json
d=json.load(open('data/state.json'))
for t in d.get('activeTasks',[]):
  print(f'  {t[\"taskId\"]} | {t[\"title\"]} | {t[\"completed\"]}/{t[\"total\"]} 步')
  for c in t.get('current',[]):
    print(f'    ⏳ {c}')
" 2>/dev/null || cat data/state.json | head -c 500
    echo ''
    echo '📋 继续执行 或 node dist/cli.js cancel-task ...'
    echo ''
  fi
fi

# 2. Slow path: cross-session CLI check (only if fast path found nothing)
if [ "$HAS_ACTIVE" = false ] && [ -f dist/cli.js ]; then
  ACTIVE=$(node dist/cli.js active-task --all 2>/dev/null)
  if ! echo "$ACTIVE" | grep -q '"activeTasks":\[\]'; then
    echo '⚠️  发现跨 session 未完成的历史 task!'
    echo "$ACTIVE" | head -c 1000
    echo ''
  fi
fi

# 3. Always show quick reference
echo '💡 Step Gate 命令:'
echo '   start-plan | checkpoint | finalize --commit-parent | cancel-task'
echo '   program status | program start | program finalize'
echo ''
echo '═══════════════════════════════════════════'
exit 0
