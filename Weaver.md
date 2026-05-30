# Weaver — Multi-Agent Orchestration Protocol

## Role model

```
Main Agent (orchestrator)
  │  Only three jobs: dispatch, verify, advance
  │  Never writes code, never executes steps
  │
  ├── Sub Agent A   Knows: taskId + taskGoal + its stepKeys
  ├── Sub Agent B   Does NOT know: full DAG, other tasks, Node/Program
  └── Sub Agent C   Does NOT know: validation logic (the Gate handles it)
```

The Main Agent injects precisely what each Sub Agent needs. No more, no less.

## Protocol: what gets passed

### Main Agent → Sub Agent (dispatch)

```json
{
  "taskId": "tsk_XXXXXX",
  "taskGoal": "Extract auth middleware into a standalone module",
  "stepKeys": {
    "tsk_XXXXXX_extract": "K8F2QZ"
  },
  "constraints": [
    "Only work on this task's scope",
    "Run step-gate checkpoint after each step",
    "Return the taskKey when all steps are done"
  ]
}
```

Critical: `stepKeys` contains the keys for currently-unlocked steps. The Sub Agent
needs these to call `checkpoint`. Without them, it can't advance. The Main Agent
gets them from the `start-plan` or `checkpoint` response.

### Sub Agent → Main Agent (return)

```json
{
  "taskId": "tsk_XXXXXX",
  "taskKey": "A1B2C3",
  "summary": "Extracted auth middleware to src/middleware/auth.ts",
  "artifacts": ["src/middleware/auth.ts", "src/middleware/index.ts"]
}
```

If the Sub Agent failed to complete all steps, it returns the current step it's
stuck on — the Main Agent can re-dispatch or reassign.

## Full lifecycle

### Phase 1 — Plan and create

```
Main Agent:
  start-plan → creates Task with DAG steps
  Receives: taskId + currentSteps + stepKeys (for unlocked steps)
```

### Phase 2 — Dispatch to Sub Agent

```
Main Agent spawns Sub Agent with the injection payload above.
Sub Agent auto-discovers session from .step-gate/bindings/.
```

### Phase 3 — Sub Agent executes

```
Sub Agent loop:
  1. Read stepKey from the injected payload (or checkpoint response)
  2. Execute the step
  3. step-gate checkpoint '{"taskId":"...","stepId":"...","stepKey":"..."}'
  4. Response gives nextSteps + nextStepKeys (if deps satisfied)
     OR allStepsCompleted: true + taskKey (if this was the last step)
```

If a merge point hasn't been reached yet (parallel branches), `nextSteps` is
empty. The Sub Agent must wait for other branches to complete before the merge
step unlocks.

### Phase 4 — Sub Agent returns

```
Sub Agent → Main Agent: { taskId, taskKey, summary, artifacts }
Main Agent: step-gate finalize '{"taskId":"...","taskKey":"..."}'
```

### Phase 5 — Verify and propagate

```
finalize returns:
  { level: "task" }      → Node has more tasks, dispatch next Sub Agent
  { level: "node" }      → Node complete, auto-generated nodeKey returned
  { level: "program" }   → All nodes done, program complete

If finalize REJECTS:
  { accepted: false, pendingSteps: [...] }
  → Sub Agent missed steps. Send it the pendingSteps list, continue checkpointing.
```

### Phase 6 — Next node

```
When level="node", Main Agent:
  program status → find next ready node
  program start <next-node>
  → start-plan → dispatch → repeat
```

## Key design rules

1. **Sub Agent never sees the full DAG.** It only knows the steps it's been given
   keys for. This prevents hallucinated dependencies and keeps context lean.

2. **Main Agent only calls `finalize`.** It doesn't need to inspect execution
   traces. The taskKey is a cryptographic proof — it either matches or it doesn't.

3. **Keys are single-use and appear once.** The Sub Agent captures them from the
   checkpoint response. The `current` command does NOT return keys. If a key is
   lost, the task must be cancelled and rebuilt with skipKey.

4. **SkipKey recovery.** If a Sub Agent dies mid-task, the Main Agent rebuilds:
   ```
   cancel-task → start-plan (with skipKey + skipTaskId for completed steps)
   ```
   Completed steps are marked `skipped`, remaining steps get fresh keys.

5. **Pure Task mode.** When Program/Node layers aren't needed, just use:
   ```
   start-plan → checkpoint × N → finalize
   ```
   The Stop Hook checks for unfinalized tasks at session end.

## Progressive disclosure

```
SKILL.md        → All agents. CLI commands + rules.
Weaver.md       → Main Agent only. How to dispatch and verify Sub Agents.
CLI + SQLite    → The Gate itself. Agents don't read this.
```
