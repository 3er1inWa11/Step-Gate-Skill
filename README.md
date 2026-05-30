# 🚦 Agent Step Gate

Lightweight execution gate for long-running AI agent tasks.

Agent Step Gate helps AI agents avoid missing planned steps during complex refactors, multi-session development, and multi-agent harness workflows.

The core idea is simple:

> Trust the agent's ability, but don't trust its claims.

Agent Step Gate does **not** try to control how an agent works.  
It only maintains an external execution ledger and verifies that planned steps have been completed before a task can be marked as done.

---

## 🚀 Quick Start

```bash
# Install globally
npm install -g agent-step-gate

# Create a task with steps
step-gate start-plan '{
  "title":"Refactor auth module",
  "steps":[
    {"id":"extract","title":"Extract middleware","dependsOn":[]},
    {"id":"jwt","title":"Add JWT validation","dependsOn":[]},
    {"id":"routes","title":"Update routes","dependsOn":["extract","jwt"]},
    {"id":"test","title":"Write tests","dependsOn":["routes"]}
  ]
}'
# → Returns taskId + stepKeys for unlocked steps

# Complete a step (unlocks downstream)
step-gate checkpoint '{"taskId":"tsk_XXX","stepId":"tsk_XXX_extract","stepKey":"K8F2QZ"}'
# → Returns nextSteps + nextStepKeys

# Finalize when all steps are done
step-gate finalize '{"taskId":"tsk_XXX","taskKey":"A1B2C3"}'
```

**One interaction = One Task.** Create a task, checkpoint each step, finalize. The external ledger ensures nothing is skipped.

For multi-session projects, see [Program mode](#program-level-usage). For multi-agent orchestration, see [Weaver.md](Weaver.md).

---

## ❓ Why

Long-context agents are capable, but they often miss steps in long-running tasks.

For example:

```text
Large refactor plan
  ├─ Phase 1: 12 tasks
  ├─ Phase 2: 15 tasks
  ├─ Phase 3: 10 tasks
  └─ ...
```

Even when the roadmap is well written, the agent may skip a step because of context drift, interruption, nested subtasks, or multi-session execution.

Agent Step Gate solves this by introducing a lightweight checkpoint system:

```text
Step completed -> StepKey issued
All Steps completed -> TaskKey issued
TaskKey verified -> Task can be considered done
```

The agent is free to execute the work however it wants, but it cannot successfully claim completion without a valid completion key.

---

## 🧠 Design Philosophy

Agent Step Gate follows several principles:

1. **Minimal interference**

   Do not constrain the agent's reasoning or implementation style.

2. **Verify completion, not behavior**

   The system does not judge whether the agent wrote good code.  
   It only checks whether the planned steps were explicitly passed.

3. **External ledger**

   Completion state is stored outside the agent context, so it is not lost when the context window becomes long.

4. **Hook-gated finalization**

   The agent may forget the Skill or CLI instruction, but the final Hook can still block incomplete tasks.

5. **Bottom-up verification**

   Verify from the smallest execution unit: `Step`.  
   Then propagate completion upward to `Task`, `Node`, and `Program`.

---

## 🏗️ Architecture

Agent Step Gate uses a four-layer model:

```text
Program
  └─ Node
       └─ Task
            └─ Step
```

### Program

A cross-session large plan.

Example:

```text
Program: Refactor authentication module
```

A Program can contain multiple Nodes.

---

### Node

A high-level work unit, usually corresponding to one session or one major stage.

Example:

```text
Node: Migrate login flow
Node: Refactor token validation
Node: Update tests
```

A Node can contain multiple Tasks.

---

### Task

The main unit for one agent interaction.

The recommended model is:

```text
One interaction = One Task
```

A Task contains concrete Steps.  
The Hook only needs to force-check the current Task.

---

### Step

The smallest checkpoint.

Example:

```text
Step 1: Read current auth implementation
Step 2: Identify token validation logic
Step 3: Refactor validation function
Step 4: Update related tests
Step 5: Run test suite
```

Each completed Step produces a `StepKey`.

When all Steps in a Task are completed, the system produces a `TaskKey`.

---

## 🔄 Core Flow

```text
1. Create or resume a Task
2. Agent executes current Step
3. Agent marks Step complete
4. Gate validates previous StepKey
5. Gate returns next StepKey
6. Repeat until all Steps are complete
7. Gate issues TaskKey
8. Hook or Main Agent verifies TaskKey
9. Task is accepted as completed
```

---

## 💻 CLI-first Workflow

Agent Step Gate is designed as a CLI-first tool.

```text
Skill  -> tells the agent how to cooperate
CLI    -> stores state, issues keys, verifies completion
Hook   -> blocks incomplete task finalization
MCP    -> optional adapter for tool-calling agents
```

The core system does not require a shared MCP server.

This makes it easier to avoid cross-terminal conflicts:

```text
Project directory
  └─ .agent-step-gate/
       ├─ state.db
       ├─ sessions/
       └─ current-task.json
```

Each project owns its local execution ledger.

---

## 🪝 Hook-gated Completion

Agent Step Gate does not need to remind the agent constantly.

A recommended pattern is:

```text
Session start:
  remind the agent to use Agent Step Gate

During work:
  do not interrupt the agent frequently

Before final answer:
  Hook checks whether the current Task is complete
```

If the Task is incomplete, the Hook blocks finalization and returns the missing Step information.

Example:

```text
Task is not complete.

Current task:
  task_auth_refactor_001

Missing steps:
  - step_004: Update related tests
  - step_005: Run test suite

Please continue the task and complete the missing steps before finalizing.
```

---

## 🤖 Multi-agent Harness Usage

Agent Step Gate can also be used as a lightweight Agent Harness primitive.

A Main Agent can assign Tasks to Sub Agents:

```text
Main Agent
  ├─ assigns Task A to Sub Agent A
  ├─ assigns Task B to Sub Agent B
  └─ verifies returned TaskKeys
```

Sub Agent flow:

```text
1. Receive TaskId
2. Complete Steps using StepKeys
3. Finalize Task
4. Return TaskKey to Main Agent
```

Main Agent does not need to inspect the full conversation or execution trace of the Sub Agent.

It only verifies:

```text
verify-task-key(taskId, taskKey)
```

If the TaskKey is valid, the Task is considered complete.

This saves context and enables scalable multi-agent orchestration.

---

## 📋 Usage Reference

For the full command list, see [SKILL.md](SKILL.md).

### Task workflow

```bash
# Create a task
step-gate start-plan '{"title":"Refactor validation","steps":[
  {"id":"read","title":"Read current logic","dependsOn":[]},
  {"id":"refactor","title":"Rewrite validation"},
  {"id":"test","title":"Run test suite"}
]}'
# → Returns taskId + currentSteps + stepKeys

# Check progress
step-gate current '{"taskId":"tsk_XXXXXX"}'

# Complete a step
step-gate checkpoint '{"taskId":"tsk_XXXXXX","stepId":"tsk_XXXXXX_read","stepKey":"K8F2QZ"}'
# → Returns nextSteps + nextStepKeys

# Finalize the task (auto-propagates to Node/Program)
step-gate finalize '{"taskId":"tsk_XXXXXX","taskKey":"A1B2C3"}'
# → Returns { level: "task" | "node" | "program" }

# Cancel a task
step-gate cancel-task '{"taskId":"tsk_XXXXXX"}'
```

### Program workflow (cross-session)

```bash
# Create a Program with nodes
step-gate program init '{"title":"Auth refactor","nodes":[
  {"id":"phase-1","title":"Extract middleware"},
  {"id":"phase-2","title":"Rewrite validation"}
]}'

# Start a node
step-gate program start '{"programId":"pgm_XXXXXX","nodeId":"phase-1"}'

# Create task inside the node
step-gate start-plan '{"title":"Phase 1 work","steps":[...]}'

# Checkpoint and finalize — completion auto-propagates

# View program status
step-gate program status '{"programId":"pgm_XXXXXX"}'

# Diagnostic health check
step-gate reconcile
```

---

## 📖 Recommended Agent Skill Instruction

A Skill can include instructions like:

```text
You are working under Agent Step Gate.

At the beginning of a task:
1. Identify the current Task.
2. Confirm the planned Steps.
3. Use the CLI to get the current StepKey.

During execution:
1. Complete the current Step.
2. Mark the Step complete with the CLI.
3. Continue until all Steps are completed.

Before final response:
1. Finalize the Task.
2. Include the TaskKey if the task is complete.
3. If the Task is incomplete, continue working instead of claiming completion.
```

The Skill is guidance only.

The real enforcement is performed by the Hook and CLI state.

---

## 🔔 Hook Behavior

The Stop Hook checks for unfinalized tasks before the agent exits. Configure in
`.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node D:/path/to/scripts/stop-hook.mjs"
      }]
    }]
  }
}
```

The hook blocks exit if a task has all steps completed but not finalized, and
warns if steps are still in progress. In strict mode (`STEP_GATE_STRICT=1`) it
exits with code 1 to hard-block session termination.

## 💾 Storage

All state is stored locally in the project directory:

```text
.step-gate/
  ├─ sessions/    — session credential files
  └─ bindings/    — CLI session auto-discovery
data/
  ├─ gate.db      — SQLite database (WAL mode)
  └─ state.json   — lightweight progress snapshot
```

## 🔑 Key Model

Agent Step Gate uses short 6-character completion keys ([A-Z0-9], ~2.1B entropy).

```text
stepKey  — proves a single step was completed (returned once in checkpoint response)
taskKey  — proves all steps in a task are done (returned in final checkpoint)
nodeKey  — system-generated receipt when a node completes (returned in finalize)
```

Only the SHA-256 hash is stored — the plaintext key is returned exactly once and
never persisted. The `current` command never returns keys.

---

## ❌ What Agent Step Gate Does Not Do

Agent Step Gate intentionally does not do these things:

- It does not evaluate code quality.
- It does not replace tests.
- It does not force the agent to use a specific implementation path.
- It does not constantly interrupt the agent.
- It does not require the Main Agent to read all Sub Agent context.
- It does not try to become a full project management system.

It only verifies execution checkpoints.

---

## 📝 Command Reference

```bash
# Task commands
step-gate start-plan '<json>'     # Create task with DAG steps
step-gate checkpoint '<json>'     # Complete a step, unlock dependents
step-gate current '<json>'        # View progress (no keys)
step-gate finalize '<json>'       # Finalize task, auto-propagate to Node/Program
step-gate cancel-task '<json>'    # Cancel current session's task
step-gate active-task             # List active tasks (--all for cross-session)

# Program commands
step-gate program init '<json>'   # Create program with nodes
step-gate program start '<json>'  # Bind session to a node
step-gate program status '<json>' # View program progress
step-gate program rebuild '<json>' # Rebuild plan (dry-run first, then --confirm)

# Diagnostics
step-gate reconcile               # Health check
```

---

## 🛠️ Development

Example stack:

- Node.js 20+ / TypeScript
- SQLite / better-sqlite3
- Zod for validation
- Cross-platform (Windows, Mac, Linux)

Install and build:

```bash
pnpm install
pnpm build
node dist/cli.js start-plan '{"title":"Test","steps":[{"id":"s1","title":"Step 1","dependsOn":[]}]}'
```


---

## 🎯 Use Cases

Agent Step Gate is useful for:

- Large refactors
- Long-context coding tasks
- Multi-session development
- Multi-agent harness orchestration
- Test migration
- Documentation rewrite
- Codebase cleanup
- Security review workflows
- Release checklist execution
- **Skill composition** — embed Agent Step Gate into other Skills to guarantee stable step execution

### Skill Composition

Any Skill with a multi-step workflow can wrap itself in Agent Step Gate to prevent skipped steps.

```
User invokes "complex-refactor" Skill
  └─ Skill internally:
       1. step-gate start-plan '{"title":"Complex refactor","steps":[...]}'
       2. Execute each step, checkpoint as you go
       3. step-gate finalize '{"taskId":"...","taskKey":"..."}'
       4. Return TaskKey as completion proof
```

Why this matters:

- **Skill authors** don't need to build their own step tracking. They declare steps, Step Gate handles the ledger.
- **Skill users** get a guarantee that the Skill's steps were actually executed, not just claimed.
- **Recursive composition** works naturally — a high-level Skill can spawn sub-Skills, each gated independently.

Example: a `db-migration` Skill

```text
Skill: db-migration
  ├─ Step 1: Snapshot current schema
  ├─ Step 2: Generate migration SQL
  ├─ Step 3: Run migration (dry-run)
  ├─ Step 4: Verify data integrity
  └─ Step 5: Apply migration

  → Agent Step Gate ensures none of these 5 steps are skipped,
    even if the agent context drifts during a multi-hour migration.
```

The Skill defines *what* to do. The Gate verifies *that it was done*.

---

## ⚡ Core Principle

```text
Do not rely on the agent's memory to guarantee task completion.

Let the agent work freely.
Let the gate verify completion.
```

---

## 📄 License

MIT
