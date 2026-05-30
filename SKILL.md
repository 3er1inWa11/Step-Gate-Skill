---
name: Step Gate
description: >
  Use this skill whenever working on multi-step tasks, large refactors, cross-session
  development, or multi-agent orchestration — any situation where skipping a planned step
  would be costly. This skill enforces an external cryptographic ledger: every planned step
  must be checkpointed with a valid key before the task can be finalized. Triggers on
  phrases like "multi-step plan", "refactor in phases", "orchestrate agents", "long task",
  "don't skip steps", "checkpoint my work", "gate my steps", or any mention of Step Gate.
---

# Step Gate — External Execution Ledger

An external cryptographic gate for agent task execution. It does not control *how* you
work — it only verifies *that you did* what you planned. Think of it as a
proof-of-work chain for agent steps: every completed step produces a cryptographic key,
and you cannot finalize a task without the final chain key.

## Why this exists

Long-context agents lose track of plans. A 15-step refactor becomes 12 steps in the
agent's memory by the time it reaches step 9. Context compression drops the original
plan. A Sub Agent claims "all done" when it skipped step 7.

The Gate solves this by moving the plan ledger **outside** the agent's context. The plan
lives in SQLite. Each step is locked behind a 6-character key. The key appears only once
in the checkpoint response — if the agent loses it, the step cannot be faked.

## Core rule

**One interaction = One Task.** At the start of each interaction, create a Task with the
steps you plan to do. Before the interaction ends, checkpoint every step and finalize
the Task. The Stop Hook will block exit if a Task is left unfinalized.

```
Interaction start → start-plan → checkpoint × N → finalize(taskKey) → done
```

Node and Program layers are optional — most work only needs the Task level.

## CLI reference

All commands return JSON. The CLI binary is at `node dist/cli.js` from the project root.

### Task commands

**start-plan** — Create a task for this interaction
```bash
node dist/cli.js start-plan '{"title":"What this task does","steps":[...]}'
```
Each step: `id` (optional), `title` (required), `dependsOn` (string array or omit for
auto-serial), `children` (nested container). First call auto-creates session files.
Returns `taskId`, `currentSteps`, and `stepKeys`.

**checkpoint** — Complete a step and unlock its dependents
```bash
node dist/cli.js checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_yy","stepKey":"KEY"}'
```
The key is consumed on use — it cannot be reused. Returns `nextSteps` + `nextStepKeys`
for newly unlocked steps. When all steps are done, returns `allStepsCompleted: true` and
a `taskKey`.

**current** — Read current progress (does NOT return keys)
```bash
node dist/cli.js current '{"taskId":"tsk_XXX"}'
```

**finalize** — Complete the task and auto-propagate upward
```bash
node dist/cli.js finalize '{"taskId":"tsk_XXX","taskKey":"KEY"}'
```
Verifies the taskKey, marks the task completed, then automatically checks whether the
parent Node (if any) and Program are also complete. Returns a `level` field: `task`,
`node`, or `program`.

**cancel-task** — Cancel the current session's task
```bash
node dist/cli.js cancel-task '{"taskId":"tsk_XXX"}'
```
Session-gated — you can only cancel your own tasks. Cross-session cancel requires
`--admin --recovery-token <token>`.

**active-task** — List active tasks
```bash
node dist/cli.js active-task          # current session only
node dist/cli.js active-task --all    # all sessions
```

### Program commands (cross-session projects)

```bash
node dist/cli.js program init '{"title":"Big project","nodes":[...]}'
node dist/cli.js program start '{"programId":"pgm_XXX","nodeId":"phase-1"}'
node dist/cli.js program status '{"programId":"pgm_XXX"}'
```

Program finalization is automatic — when the last Task in the last Node is finalized,
the system propagates completion all the way up. No manual `program finalize` needed.

**program rebuild** — Rebuild node/program after plan changes (dry-run first, then `--confirm`)
```bash
node dist/cli.js program rebuild '{"programId":"pgm_XXX"}'          # dry-run
node dist/cli.js program rebuild '{"programId":"pgm_XXX"}' --confirm
```

Always show the user the dry-run output and get confirmation before running `--confirm`.

### Diagnostics

```bash
node dist/cli.js gate reconcile                   # full read-only health check
node dist/cli.js gate reconcile '{"programId":"pgm_XXX"}'  # scoped to one program
```

## DAG rules

**Example — parallel branches + merge point:**
```bash
node dist/cli.js start-plan '{
  "title":"Backend refactor",
  "steps":[
    {"id":"auth","title":"Auth module","dependsOn":[]},
    {"id":"api","title":"API layer","dependsOn":[]},
    {"id":"db","title":"DB migration","dependsOn":["auth"]},
    {"id":"test","title":"Integration tests","dependsOn":["api","db"]}
  ]
}'
# auth + api activate immediately; db waits for auth; test waits for api + db
```

| dependsOn | Behavior |
|-----------|----------|
| `[]` (explicit empty) | Parallel entry — activated immediately |
| omitted / undefined | Auto-serial — depends on previous leaf |
| `["a", "b"]` | Merge point — unlocks after both a and b complete |
| Container with children | Children inherit the container's dependsOn |
| `skipKey` + `skipTaskId` | Skip a previously completed step (one-time use) |

Cycle detection runs at plan creation time — circular dependencies are rejected before
any step starts.

## Interruption recovery

When a session is interrupted, completed steps are permanent cryptographic proofs:

```bash
# Rebuild with skipKey to jump past already-completed steps
node dist/cli.js start-plan '{
  "title":"Resume wave 2",
  "steps":[
    {"id":"auth","title":"Auth module","dependsOn":[],"skipKey":"OLD_KEY","skipTaskId":"tsk_OLD"},
    {"id":"ci","title":"CI tests","dependsOn":["auth"]}
  ]
}'
```

A skipKey can only be consumed once — the system writes a `skip_key_consumed` event on
first use and rejects subsequent attempts. Skipped steps are marked `skipped` (not
`completed`) to preserve traceability.

## Key rules

1. Keys appear exactly once — in the checkpoint or start-plan response. If lost, they
   cannot be recovered. The `current` command never returns keys.
2. Step double-consumption is impossible — the DB transaction uses `WHERE status='current'`
   with an affected-rows guard.
3. Cancel-task is session-gated — agents cannot cancel tasks they don't own.
4. SkipKey is one-time — the `events` table records every consumption.
5. Cycle detection runs at plan creation — dead DAGs are rejected before execution.

The Gate is a proof-of-completion system, not a security product. It protects against
agent hallucination, context loss, and accidental step-skipping. It does not protect
against deliberate external attack.

## Session files

The first `start-plan` call creates:
- `.step-gate/sessions/ses_XXXXXX.json` — session credentials
- `.step-gate/bindings/bind_cli_XXXXXX.json` — hook binding

The CLI auto-discovers the session from binding files. No manual session management needed.

## Further reading

- `Weaver.md` — Multi-agent orchestration: how a Main Agent spawns Sub Agents, injects
  taskId + stepKey, and verifies returned taskKeys. Read this before orchestrating
  parallel Sub Agents.
- `ARCHITECTURE.md` — Full architecture: 4-layer model, 7 DB tables, 5 credential types,
  12 CLI commands, 20+ core functions
- `docs/security-stress-test-report.md` — Security audit: 9 issues, all resolved
