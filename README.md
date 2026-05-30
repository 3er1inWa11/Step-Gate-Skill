# 🚦 Agent Step Gate

Lightweight execution gate for long-running AI agent tasks.

Agent Step Gate helps AI agents avoid missing planned steps during complex refactors, multi-session development, and multi-agent harness workflows.

The core idea is simple:

> Trust the agent's ability, but don't trust its claims.

Agent Step Gate does **not** try to control how an agent works.  
It only maintains an external execution ledger and verifies that planned steps have been completed before a task can be marked as done.

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

## 📋 Example

### Create a task

```bash
asg task create \
  --title "Refactor auth token validation" \
  --steps "Read current implementation" \
          "Refactor validation logic" \
          "Update tests" \
          "Run test suite"
```

Output:

```text
Task created: task_abc123
Current step: step_001
StepKey: K8F2QZ
```

---

### Complete a step

```bash
asg step complete \
  --task task_abc123 \
  --step step_001 \
  --key K8F2QZ
```

Output:

```text
Step completed: step_001
Next step: step_002
StepKey: 9XLM2A
```

---

### Finalize a task

```bash
asg task finalize \
  --task task_abc123
```

If all Steps are complete:

```text
Task completed.
TaskKey: TK_7H3Q9Z2M
```

If not complete:

```text
Task incomplete.

Missing steps:
  - step_003: Update tests
  - step_004: Run test suite
```

---

### Verify a TaskKey

```bash
asg task verify \
  --task task_abc123 \
  --key TK_7H3Q9Z2M
```

Output:

```text
TaskKey valid.
```

---

## 📦 Program-level Usage

For large cross-session work, create a Program:

```bash
asg program create --title "Authentication module refactor"
```

Create Nodes under the Program:

```bash
asg node create \
  --program pgm_auth_refactor \
  --title "Token validation refactor"
```

Create Tasks under a Node:

```bash
asg task create \
  --node node_token_validation \
  --title "Refactor token validation implementation" \
  --steps "Read implementation" \
          "Modify validation logic" \
          "Update tests" \
          "Run tests"
```

Completion propagates naturally:

```text
All Steps completed
  -> Task completed
  -> Node may become completed
  -> Program may become completed
```

The Hook only needs to force-check the current Task.

Program and Node are higher-level planning structures and can be finalized manually or through Skill guidance.

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

The Stop Hook should check the current Task before the agent gives a final answer.

Pseudo logic:

```text
on_stop:
  currentTask = get_current_task()

  if no current task:
    allow

  result = check_task(currentTask)

  if result.completed:
    allow

  block with missing step summary
```

Example command:

```bash
asg hook check-stop
```

Possible output:

```json
{
  "allow": false,
  "taskId": "task_abc123",
  "missingSteps": [
    {
      "stepId": "step_003",
      "title": "Update tests"
    }
  ]
}
```

---

## 💾 Storage

Agent Step Gate stores local project state.

Recommended storage:

```text
.agent-step-gate/
  ├─ state.db
  ├─ current-session.json
  ├─ current-task.json
  └─ logs/
```

Suggested implementation:

- SQLite
- WAL mode
- Append-only event log where possible
- Project-local isolation

---

## 🔑 Key Model

Agent Step Gate uses short completion keys.

```text
StepKey:
  issued after a Step is accepted

TaskKey:
  issued after all Steps in a Task are completed
```

Keys should be generated by the system, not by the agent.

Recommended generation:

```text
randomBytes -> base32/base36 string -> hash before storing
```

Store only the hash of the key.

Example:

```text
raw key:  K8F2QZ
stored:   sha256(K8F2QZ)
```

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

## 📝 Suggested Commands

The exact command names can be adapted, but the recommended command groups are:

```bash
asg program create
asg program status
asg program finalize

asg node create
asg node status
asg node finalize

asg task create
asg task current
asg task status
asg task finalize
asg task verify

asg step current
asg step complete

asg hook check-stop
asg resume
```

---

## 🛠️ Development

Example stack:

- Node.js / TypeScript
- SQLite / better-sqlite3
- Zod for validation
- Vitest for tests
- Optional MCP adapter

Install dependencies:

```bash
pnpm install
```

Run tests:

```bash
pnpm test
```

Build:

```bash
pnpm build
```

Run locally:

```bash
pnpm dev
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
       1. asg task create --title "Complex refactor" --steps [...]
       2. Execute each step, checkpoint as you go
       3. asg task finalize
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
