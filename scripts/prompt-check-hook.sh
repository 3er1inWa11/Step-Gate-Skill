#!/usr/bin/env bash
# Agent Step Gate — UserPromptSubmit Hook
# Lightweight check before each interaction.
# Reads data/state.json (written by CLI after state changes).

if [ ! -f data/state.json ]; then exit 0; fi

HAS_ACTIVE=$(grep -o '"hasActiveTask": *true' data/state.json 2>/dev/null)
if [ -n "$HAS_ACTIVE" ]; then
  INFO=$(python3 -c "
import json
d=json.load(open('data/state.json'))
for t in d.get('activeTasks',[]):
  print(f'  ⚠️  {t[\"taskId\"]} | {t[\"title\"]} | {t[\"completed\"]}/{t[\"total\"]} 步完成')
  for c in t.get('current',[]):
    print(f'     ⏳ {c}')
" 2>/dev/null)
  if [ -n "$INFO" ]; then
    echo '---'
    echo '🔒 Step Gate: 当前有未完成任务'
    echo "$INFO"
    echo ''
    echo '完成 checkpoint 或 cancel-task 后方可退出。'
    echo '---'
  fi
fi
exit 0
