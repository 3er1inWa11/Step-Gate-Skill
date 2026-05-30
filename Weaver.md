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

## Main Agent → Sub Agent dispatch template

Copy this into the Sub Agent's prompt when spawning. Replace `{{...}}` placeholders:

```
You are working under Step Gate. A task has already been created for you.

**Task ID**: {{taskId}}
**Goal**: {{taskGoal}}

**Current unlocked steps and their keys:**
{{#each currentSteps}}
  - Step: {{stepId}} ({{path}}) → Key: {{stepKey}}
{{/each}}

**Rules:**
1. Execute one step at a time. After completing a step, run:
   step-gate checkpoint '{"taskId":"{{taskId}}","stepId":"<stepId>","stepKey":"<stepKey>"}'
2. The checkpoint response will give you nextSteps + nextStepKeys if downstream
   steps are now unlocked. Use those keys to continue.
3. If checkpoint returns allStepsCompleted: true, you will receive a taskKey.
   STOP and report it back — do NOT call finalize yourself.
4. If checkpoint returns an empty nextSteps list, there may be parallel branches
   still running. Wait for the Main Agent to tell you to proceed.
5. NEVER call the current command expecting to get keys back — it does NOT
   return keys. Keys only appear in start-plan and checkpoint responses.

**When you finish all your steps:**
Report back to the Main Agent:
  - taskId: {{taskId}}
  - taskKey: <from the final checkpoint>
  - summary: what you accomplished
  - artifacts: list of files changed/created

The Main Agent will verify your taskKey with finalize.
```

## Sub Agent execution loop (what it actually does)

```
1. Read stepKey from the injected prompt
2. Execute the step
3. step-gate checkpoint '{"taskId":"...","stepId":"...","stepKey":"..."}'
4. Parse response:
   - { nextSteps: [...], nextStepKeys: {...} } → go to step 1 with new keys
   - { allStepsCompleted: true, taskKey: "..." } → DONE, report to Main Agent
   - { nextSteps: [] } → no new steps unlocked, report to Main Agent (parallel wait)
```

If the Sub Agent hits an error or can't complete a step, it stops and reports
the current state back to the Main Agent.

## Sub Agent → Main Agent (return)

```json
{
  "taskId": "tsk_XXXXXX",
  "taskKey": "A1B2C3",
  "summary": "Extracted auth middleware to src/middleware/auth.ts",
  "artifacts": ["src/middleware/auth.ts", "src/middleware/index.ts"]
}
```

If incomplete (couldn't finish all steps):
```json
{
  "taskId": "tsk_XXXXXX",
  "status": "partial",
  "completedSteps": ["extract", "jwt"],
  "pendingStep": "routes",
  "reason": "Missing dependency or blocked"
}
```

## Main Agent verify phase (after Sub Agent returns)

```
Main Agent receives taskKey → calls:
  step-gate finalize '{"taskId":"...","taskKey":"..."}'

  ✅ Accepted:
    { level: "task" }      → Node has more tasks, dispatch next Sub Agent
    { level: "node" }      → Node complete, nodeKey returned, next node unlocked
    { level: "program" }   → All nodes done, program complete

  ❌ Rejected:
    { accepted: false, pendingSteps: [...] }
    → Sub Agent lied or missed steps. Feed pendingSteps back and continue.
```

## Sub Agent end-of-work self-check

Before a Sub Agent reports "done" to the Main Agent, it MUST verify:

1. `step-gate active-task` — if its taskId is still listed, it's not finalized
2. If taskKey was obtained from checkpoint, report it immediately (don't lose it)
3. If taskKey was NOT obtained, report which step is still pending

The Sub Agent does NOT call finalize. Only the Main Agent holds that
responsibility — it verifies the taskKey cryptographically.

## Full lifecycle summary

```
Main Agent:
  start-plan → taskId + currentSteps + stepKeys
  Spawn Sub Agent with dispatch template (above)
  Wait for Sub Agent return
  finalize(taskId, taskKey)
  → level="task" → dispatch next task
  → level="node" → program start next node, repeat
  → level="program" → done
```

## Key rules

1. **Sub Agent never sees the full DAG.** Injected stepKeys limit what it can do.
2. **Main Agent calls finalize, not Sub Agent.** Verification is centralized.
3. **Keys appear once.** Lost key = cancel + rebuild with skipKey.
4. **Sub Agent self-checks before return.** `active-task` confirms status.
5. **No shared MCP server.** Each agent calls `step-gate` CLI independently.
   Session auto-discovery via `.step-gate/bindings/`.
