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

**Before dispatching:** The Main Agent MUST break the work into concrete, verifiable Steps (see SKILL.md Step granularity rules). Each Step should be one specific action. Never dispatch a Sub Agent with a single vague step like "do the work."

Copy this into the Sub Agent's prompt when spawning. Replace `{{...}}` placeholders:

```
You are working under Step Gate. A task has already been created for you.

**Task ID**: {{taskId}}
**Goal**: {{taskGoal}}
**Workspace**: {{workspacePath}}

**Your assigned steps and their keys:**
{{#each currentSteps}}
  - Step: {{stepId}} → "{{path}}" → Key: {{stepKey}}
{{/each}}

**Rules:**
1. **You MUST run all step-gate commands from the workspace directory.** The database
   is stored at `{{workspacePath}}/.step-gate/gate.db`. If you run from a different
   directory, you will NOT find the task.
   ```bash
   cd {{workspacePath}}
   # then run step-gate commands
   ```
2. Execute one step at a time. After completing a step, run:
   step-gate checkpoint '{"taskId":"{{taskId}}","stepId":"<stepId>","stepKey":"<stepKey>"}'
3. The checkpoint response will give you nextSteps + nextStepKeys if downstream
   steps are now unlocked. Use those keys to continue.
4. If checkpoint returns allStepsCompleted: true, you will receive a taskKey.
   STOP and report it back — do NOT call finalize yourself.
5. If checkpoint returns an empty nextSteps list, there may be parallel branches
   still running. Wait for the Main Agent to tell you to proceed.
6. NEVER call the current command expecting to get keys back — it does NOT
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
4. Parse the checkpoint response:
   ┌──────────────────────────────────────────────────────────────┐
   │ { nextSteps: [...], nextStepKeys: {...} }                    │
   │   → More steps unlocked. Go to step 1 with new keys.        │
   │                                                              │
   │ { allStepsCompleted: true, taskKey: "A1B2C3" }              │
   │   → ALL DONE. The taskKey is the completion proof.          │
   │   → Report it to the Main Agent immediately.                │
   │   → Do NOT call finalize — that's the Main Agent's job.     │
   │                                                              │
   │ { nextSteps: [] } (no allStepsCompleted)                     │
   │   → This step is done but the merge point isn't ready.      │
   │   → Other parallel branches are still running.              │
   │   → Report to Main Agent: "step done, waiting for others".  │
   └──────────────────────────────────────────────────────────────┘
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

## Task split negotiation (Sub Agent discovers work is too heavy)

**Sub Agent must NEVER cancel a task or create a new task.** Only the Main Agent
holds these permissions (enforced via settings.json — see below).

When a Sub Agent discovers its assigned task is too heavy:

### Step 1 — Sub Agent checkpoint then report

**Do NOT just report without checkpointing.** Checkpoint everything you've already
completed — those proofs are permanent and will be skipped on rebuild.

Then report the split recommendation to the Main Agent:

```json
{
  "taskId": "tsk_XXXXXX",
  "status": "too_heavy",
  "completedSteps": ["extract", "jwt"],
  "completedStepKeys": { "extract": "KEY1", "jwt": "KEY2" },
  "blockedStep": "routes",
  "blockedStepKey": "KEY3",
  "splitRecommendation": [
    { "title": "routes — GET endpoints", "steps": ["GET /users", "GET /users/:id"] },
    { "title": "routes — mutation endpoints", "steps": ["POST /users", "PUT /users/:id", "DELETE /users/:id"] }
  ],
  "reason": "routes 这个 step 包含 5 个端点实现，建议拆成 2 个 Task"
}
```

### Step 2 — Main Agent decision

Main Agent has three options:

**Option A: Cancel + rebuild (recommended for most cases)**

```bash
# 1. Cancel the current task (admin mode — Main Agent owns the session)
step-gate cancel-task '{"taskId":"tsk_XXX"}'

# 2. Rebuild with skipKey to preserve completed steps
step-gate start-plan '{
  "title":"routes — GET endpoints",
  "steps":[
    {"id":"extract","title":"提取中间件","skipKey":"KEY1","skipTaskId":"tsk_XXX"},
    {"id":"jwt","title":"JWT验证","skipKey":"KEY2","skipTaskId":"tsk_XXX"},
    {"id":"getUsers","title":"GET /users","dependsOn":["jwt"]}
  ]
}'

# 3. Create second task for remaining work
step-gate start-plan '{
  "title":"routes — mutation endpoints",
  "steps":[...]
}'

# 4. Dispatch two new Sub Agents with the new taskIds
```

**Option B: Let Sub Agent continue with remaining steps**

If the Main Agent decides the task is NOT too heavy, it tells the Sub Agent
to continue. The Sub Agent already has the keys from the initial dispatch.

**Option C: Main Agent absorbs remaining work**

Main Agent checkpoints the remaining steps itself, skipping Sub Agent dispatch.

### Step 3 — Verify skipKey security

SkipKey is one-time use. The `events` table records every consumption. If a
Sub Agent maliciously tries to reuse a skipKey, the system rejects it at the
DB transaction level. The cancelled task's completed steps remain as permanent
audit records (status `completed`), while rebuilt steps are marked `skipped`.

## Permissions enforcement

Step Gate is CLI-only (not MCP). All commands run via `node dist/cli.js <command>`.
Enforcement happens at two levels:

### 1. Bash allow list (project `.claude/settings.local.json`)

Only whitelisted CLI commands auto-execute. Destructive commands require user approval:

```json
{
  "permissions": {
    "allow": [
      "Bash(node dist/cli.js checkpoint *)",
      "Bash(node dist/cli.js current *)",
      "Bash(node dist/cli.js active-task *)"
    ]
  }
}
```

`cancel-task`, `start-plan`, `finalize`, and `program *` are NOT in the allow list.
When a Sub Agent tries to call them, the user gets a confirmation prompt — and can
deny it.

### 2. Protocol rules (this document)

**Sub Agent must NEVER call:**

| Forbidden | Why |
|-----------|-----|
| `finalize` | Only Main Agent verifies taskKey |
| `cancel-task` | Only Main Agent can cancel/replan |
| `start-plan` | Only Main Agent creates tasks |
| `program *` | Only Main Agent manages program structure |

**Sub Agent is only allowed:**

| Allowed | Purpose |
|---------|---------|
| `checkpoint` | Report step completion |
| `current` | Check task progress |
| `active-task` | Self-check (read-only) |

If a Sub Agent violates these rules, the user sees a Bash permission prompt.
The SubagentStop Hook then reminds the Main Agent to verify the Sub Agent's work.

## How the Sub Agent knows it's done

The Sub Agent does NOT call `finalize`. Instead, the **last checkpoint** tells it:

```bash
step-gate checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_tests","stepKey":"M3N4O5"}'
```

If this was the final step, the response is:
```json
{
  "accepted": true,
  "completedStep": { "stepId": "tsk_XXX_tests", "path": "Write tests" },
  "allStepsCompleted": true,
  "taskKey": "P6Q7R8"
}
```

`allStepsCompleted: true` + `taskKey` = proof of completion. The Sub Agent now knows
every step is done and holds the cryptographic proof. It does NOT need to verify
this itself — the `taskKey` IS the verification, generated by the Gate.

## Main Agent verify phase (after Sub Agent returns)

The Sub Agent returns the `taskKey`. The Main Agent validates it with `finalize`:

```
step-gate finalize '{"taskId":"...","taskKey":"P6Q7R8"}'

  ✅ Accepted:
    { level: "task" }      → Node has more tasks, dispatch next Sub Agent
    { level: "node" }      → Node complete, nodeKey returned, next node unlocked
    { level: "program" }   → All nodes done, program complete

  ❌ Rejected:
    { accepted: false, pendingSteps: [...] }
    → Sub Agent lied or missed steps. Feed pendingSteps back and continue.
```

This separation matters: the Sub Agent gets a proof from checkpoint, the Main Agent
validates it with finalize. The Sub Agent can't close the task — only the Main
Agent can, after verifying the taskKey is genuine.

## Sub Agent end-of-work self-check

Before a Sub Agent reports "done" to the Main Agent, it MUST verify:

1. `step-gate current '{"taskId":"<taskId>"}'` — reads task progress directly by taskId. This works cross-session (no session binding needed). If status is still active with currentSteps, work remains.
2. If taskKey was obtained from checkpoint, report it immediately (don't lose it)
3. If taskKey was NOT obtained, report which step is still pending

**Never use `active-task` for self-check** — `active-task` filters by session and may return empty if the Sub Agent's session auto-discovery resolves to a different session than the one that created the Task.

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
4. **Sub Agent self-checks before return.** Use `current '{"taskId":"..."}'` — bypasses session filter.
5. **No shared MCP server.** Each agent calls `step-gate` CLI independently.
   Session auto-discovery via `.step-gate/bindings/`.
