import crypto from 'node:crypto';
import db from '../storage/db.js';
import { randomCode, generateNodeKey, generateStepKey, generateTaskKey, hashKey } from './keys.js';
import { flattenPlan } from './plan.js';
import type { PlanNode, LeafStep, StepRow, TaskRow, CurrentStepInfo } from '../types/index.js';

function now(): string { return new Date().toISOString(); }
function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

export interface ProgramInfo {
  programId: string;
  title: string;
  totalNodes: number;
  nodes: ProgramNodeInfo[];
}

export interface ProgramNodeInfo {
  nodeId: string;
  title: string;
  description?: string;
  orderIndex: number;
  status: string;
  sessionId?: string;
}

export interface NodeTaskDef {
  id?: string;
  title: string;
  steps: PlanNode[];
}

export interface ProgramTaskInfo {
  taskId: string;
  nodeId: string;
  title: string;
  totalSteps: number;
  currentSteps: CurrentStepInfo[];
  stepKeys: Record<string, string>;
}

export interface CreateProgramResult extends ProgramInfo {
  tasks: ProgramTaskInfo[];
}

/** Create a program from a plan. Nodes may optionally contain tasks+steps for bulk
 *  registration. Node-level dependsOn gates task activation: tasks under a node
 *  whose dependencies are unsatisfied stay fully pending. */
export function createProgram(
  title: string,
  nodes: { id?: string; title: string; description?: string; dependsOn?: string[]; tasks?: NodeTaskDef[] }[],
): CreateProgramResult {
  const programId = `pgm_${randomCode(6)}`;
  const ts = now();

  db.prepare('INSERT INTO programs (program_id, title, status, total_nodes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(programId, title, 'active', nodes.length, ts, ts);

  // Resolve node IDs first so dependsOn references work
  const resolvedNodes = nodes.map((n, i) => ({
    ...n,
    _nodeId: n.id ? `${programId}_${n.id}` : `nd_${programId}_${i + 1}`,
    _orderIndex: i + 1,
  }));

  // Build node ID → status lookup for dependency checking
  // Nodes with no deps are "ready"; nodes with deps are "waiting"
  const nodeStatuses = new Map<string, 'ready' | 'waiting'>();
  for (const n of resolvedNodes) {
    const deps = n.dependsOn || [];
    // Resolve dependsOn to full node IDs
    const depIds = deps.map(d => {
      const found = resolvedNodes.find(r => r.id === d || r._nodeId.endsWith(`_${d}`));
      return found ? found._nodeId : `${programId}_${d}`;
    });
    nodeStatuses.set(n._nodeId, depIds.length === 0 ? 'ready' : 'waiting');
    (n as any)._depNodeIds = depIds;
  }

  // Insert all nodes
  const programNodes: ProgramNodeInfo[] = [];
  for (const n of resolvedNodes) {
    db.prepare('INSERT INTO program_nodes (node_id, program_id, title, description, order_index, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(n._nodeId, programId, n.title, n.description ?? null, n._orderIndex, 'pending', ts);
    programNodes.push({ nodeId: n._nodeId, title: n.title, description: n.description, orderIndex: n._orderIndex, status: 'pending' });
  }

  const allTaskInfos: ProgramTaskInfo[] = [];

  // Create one session per node (for task ownership + later program start binding)
  const nodeSessionMap = new Map<string, string>();

  // Create tasks + steps for nodes that have them
  for (const n of resolvedNodes) {
    if (!n.tasks || n.tasks.length === 0) continue;

    // One session per node
    const nodeSessionId = `ses_${randomCode(6)}`;
    nodeSessionMap.set(n._nodeId, nodeSessionId);
    db.prepare('INSERT INTO sessions (session_id, session_secret_hash, recovery_token_hash, workspace, program_id, program_node_id, created_by_cli, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nodeSessionId, sha256(randomCode(6)), sha256(randomCode(6)), process.cwd(), programId, n._nodeId, 'program_init', ts, ts);

    for (const tDef of n.tasks) {
      const taskId = tDef.id ? `${programId}_${n.id}_${tDef.id}` : `tsk_${randomCode(6)}`;
      const leafSteps = flattenPlan(tDef.steps, taskId);

      if (leafSteps.length === 0) continue;

      const task: TaskRow = {
        id: taskId, title: tDef.title, status: 'active', currentIndex: 1,
        totalSteps: leafSteps.length, finalKeyHash: null, sessionId: nodeSessionId,
        createdAt: ts, updatedAt: ts,
      };

      const stepKeys: Record<string, string> = {};
      const steps: StepRow[] = leafSteps.map((ls, i) => {return {
          id: ls.id, taskId: ls.taskId, parentPath: ls.parentPath, title: ls.title,
          path: ls.path, orderIndex: ls.orderIndex, dependsOn: ls.dependsOn,
          status: 'pending' as const, stepKeyHash: null, completedAt: null, createdAt: ls.createdAt,
        };
      });

      // Insert task + steps in transaction
      const insertTask = db.prepare(`
        INSERT INTO tasks (id, title, status, current_index, total_steps, final_key_hash, session_id, created_at, updated_at)
        VALUES (@id, @title, @status, @currentIndex, @totalSteps, @finalKeyHash, @sessionId, @createdAt, @updatedAt)
      `);
      const insertStep = db.prepare(`
        INSERT INTO steps (id, task_id, parent_path, title, path, order_index, depends_on, status, step_key_hash, completed_at, created_at)
        VALUES (@id, @taskId, @parentPath, @title, @path, @orderIndex, @dependsOn, @status, @stepKeyHash, @completedAt, @createdAt)
      `);

      db.transaction(() => {
        insertTask.run({
          id: task.id, title: task.title, status: task.status, currentIndex: task.currentIndex,
          totalSteps: task.totalSteps, finalKeyHash: task.finalKeyHash, sessionId: task.sessionId,
          createdAt: task.createdAt, updatedAt: task.updatedAt,
        });
        for (const step of steps) {
          insertStep.run({
            id: step.id, taskId: step.taskId, parentPath: step.parentPath, title: step.title,
            path: step.path, orderIndex: step.orderIndex, dependsOn: JSON.stringify(step.dependsOn),
            status: step.status, stepKeyHash: step.stepKeyHash, completedAt: step.completedAt,
            createdAt: step.createdAt,
          });
        }
      })();

      allTaskInfos.push({
        taskId: task.id,
        nodeId: n._nodeId,
        title: task.title,
        totalSteps: task.totalSteps,
        currentSteps: steps.filter(s => s.status === 'current').map(s => ({
          stepId: s.id, path: s.path, index: s.orderIndex, total: task.totalSteps,
        })),
        stepKeys,
      });
    }
  }

  return { programId, title, totalNodes: nodes.length, nodes: programNodes, tasks: allTaskInfos };
}

/** Get program status with all nodes. */
export function getProgramStatus(programId: string): ProgramInfo | null {
  const p = db.prepare('SELECT * FROM programs WHERE program_id = ?').get(programId) as any;
  if (!p) return null;
  const nodes = db.prepare('SELECT * FROM program_nodes WHERE program_id = ? ORDER BY order_index').all(programId) as any[];
  return {
    programId: p.program_id,
    title: p.title,
    totalNodes: p.total_nodes,
    nodes: nodes.map((n: any) => ({
      nodeId: n.node_id, title: n.title, description: n.description,
      orderIndex: n.order_index, status: n.status, sessionId: n.session_id,
    })),
  };
}

/** Find ready nodes (all deps satisfied, not yet started). */
export function getReadyNodes(programId: string): ProgramNodeInfo[] {
  const nodes = db.prepare("SELECT * FROM program_nodes WHERE program_id = ? AND status = 'pending' ORDER BY order_index").all(programId) as any[];
  // For now, no DAG at program level — just return ordered pending nodes.
  // Future: filter by depends_on satisfaction.
  return nodes.map((n: any) => ({
    nodeId: n.node_id, title: n.title, description: n.description,
    orderIndex: n.order_index, status: n.status, sessionId: n.session_id,
  }));
}

/** Start a program node — activates pre-registered tasks and returns task info.
 *  If a session was pre-created for this node (via program init with tasks),
 *  reuses it. Otherwise creates a new one. */
export function startProgramNode(programId: string, nodeId: string, sessionId?: string): {
  ok: boolean;
  sessionId: string;
  tasks: ProgramTaskInfo[];
} {
  const node = db.prepare('SELECT * FROM program_nodes WHERE node_id = ? AND program_id = ?').get(nodeId, programId) as any;
  if (!node || node.status !== 'pending') return { ok: false, sessionId: '', tasks: [] };

  // Reuse pre-created session if one exists for this node
  const existingSession = db.prepare(
    "SELECT session_id FROM sessions WHERE program_id = ? AND program_node_id = ? AND created_by_cli = 'program_init'"
  ).get(programId, nodeId) as { session_id: string } | undefined;

  const sid = existingSession?.session_id ?? (sessionId ?? `ses_${randomCode(6)}`);
  const ts = now();

  if (!existingSession) {
    db.prepare('INSERT INTO sessions (session_id, session_secret_hash, recovery_token_hash, workspace, program_id, program_node_id, created_by_cli, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, sha256(randomCode(6)), sha256(randomCode(6)), process.cwd(), programId, nodeId, 'program_start', ts, ts);
  }

  db.prepare("UPDATE program_nodes SET status = 'in_progress', session_id = ? WHERE node_id = ?")
    .run(sid, nodeId);

  // Return pre-registered tasks under this node's session.
  // If they already have current steps (from program init for a ready node), return those.
  // Otherwise activate the first pending steps.
  const tasks: ProgramTaskInfo[] = [];
  const taskRows = db.prepare("SELECT * FROM tasks WHERE session_id = ? AND status = 'active' ORDER BY created_at").all(sid) as any[];

  for (const t of taskRows) {
    const allSteps = db.prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY order_index').all(t.id) as any[];

    // Check if already has active steps (from program init)
    const existingCurrent = allSteps.filter((s: any) => s.status === 'current');
    if (existingCurrent.length > 0) {
      const stepKeys: Record<string, string> = {};
      const currentSteps: CurrentStepInfo[] = [];
      for (const s of existingCurrent) {
        // Reconstruct key from stored hash — keys are 6-char, hash is sha256
        // We can't reverse the hash, but we already returned keys at init time.
        // The caller should use the init response's keys.
        // For program start, we just report what's active.
        currentSteps.push({ stepId: s.id, path: s.path, index: s.order_index, total: t.total_steps });
      }
      tasks.push({
        taskId: t.id, nodeId, title: t.title,
        totalSteps: t.total_steps, currentSteps, stepKeys: {},
      });
      continue;
    }

    // No active steps — activate pending steps with no unsatisfied deps
    const readySteps = allSteps.filter((s: any) => {
      if (s.status !== 'pending') return false;
      const deps: string[] = s.depends_on ? JSON.parse(s.depends_on) : [];
      if (deps.length === 0) return true;
      return deps.every((depId: string) => {
        const dep = allSteps.find((x: any) => x.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });
    });

    if (readySteps.length === 0) continue;

    const stepKeys: Record<string, string> = {};
    const currentSteps: CurrentStepInfo[] = [];

    for (const step of readySteps) {
      const { plaintext, hash } = generateStepKey();
      stepKeys[step.id] = plaintext;
      db.prepare("UPDATE steps SET status = 'current', step_key_hash = ? WHERE id = ?").run(hash, step.id);
      currentSteps.push({ stepId: step.id, path: step.path, index: step.order_index, total: t.total_steps });
    }

    tasks.push({
      taskId: t.id, nodeId, title: t.title,
      totalSteps: t.total_steps, currentSteps, stepKeys,
    });
  }

  return { ok: true, sessionId: sid, tasks };
}

/** Commit parent: mark the program node as completed, auto-generating a nodeKey receipt. */
export function commitProgramNode(sessionId: string): { programId: string; nodeId: string; nodeKey?: string; allDone: boolean } | null {
  const session = db.prepare('SELECT program_id, program_node_id FROM sessions WHERE session_id = ?').get(sessionId) as any;
  if (!session?.program_node_id) return null;

  // Generate nodeKey as a completion receipt
  const { plaintext: nodeKey, hash: nodeKeyHash } = generateNodeKey();
  db.prepare("UPDATE program_nodes SET status = 'completed', completed_at = ?, node_key_hash = ? WHERE node_id = ?")
    .run(now(), nodeKeyHash, session.program_node_id);

  // Check if all nodes are completed
  const pending = db.prepare("SELECT COUNT(*) as cnt FROM program_nodes WHERE program_id = ? AND status != 'completed'")
    .get(session.program_id) as any;

  if (pending.cnt === 0) {
    db.prepare("UPDATE programs SET status = 'completed', updated_at = ? WHERE program_id = ?")
      .run(now(), session.program_id);
    return { programId: session.program_id, nodeId: session.program_node_id, nodeKey, allDone: true };
  }

  return { programId: session.program_id, nodeId: session.program_node_id, nodeKey, allDone: false };
}

/** Rebuild manifest: what's done and what will be lost if we rebuild this program/node. */
export interface RebuildManifest {
  scope: { programId: string; nodeId?: string };
  programTitle: string;
  completedSteps: Array<{
    oldTaskId: string;
    taskTitle: string;
    stepId: string;
    stepPath: string;
    status: string;
    nodeId?: string;
  }>;
  pendingSteps: Array<{
    taskId: string;
    taskTitle: string;
    stepId: string;
    stepPath: string;
  }>;
  activeTaskCount: number;
  completedTaskCount: number;
}

export function getRebuildManifest(programId: string, nodeId?: string): RebuildManifest | null {
  const prog = db.prepare('SELECT * FROM programs WHERE program_id = ?').get(programId) as any;
  if (!prog) return null;

  // Find sessions under this program (optionally filtered by node)
  let sessions: any[];
  if (nodeId) {
    sessions = db.prepare("SELECT * FROM sessions WHERE program_id = ? AND program_node_id = ?").all(programId, nodeId) as any[];
  } else {
    sessions = db.prepare("SELECT * FROM sessions WHERE program_id = ?").all(programId) as any[];
  }

  const sessionIds = sessions.map((s: any) => s.session_id);
  if (sessionIds.length === 0) {
    return {
      scope: { programId, nodeId },
      programTitle: prog.title,
      completedSteps: [],
      pendingSteps: [],
      activeTaskCount: 0,
      completedTaskCount: 0,
    };
  }

  // Find all tasks from these sessions
  const placeholders = sessionIds.map(() => '?').join(',');
  const tasks = db.prepare(`SELECT * FROM tasks WHERE session_id IN (${placeholders})`).all(...sessionIds) as any[];

  const completedSteps: RebuildManifest['completedSteps'] = [];
  const pendingSteps: RebuildManifest['pendingSteps'] = [];
  let activeCount = 0;
  let completedCount = 0;

  for (const task of tasks) {
    if (task.status === 'completed') completedCount++;
    if (task.status === 'active' || task.status === 'cancelled') activeCount++;

    const steps = db.prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY order_index').all(task.id) as any[];
    const node = sessions.find((s: any) => s.session_id === task.session_id);

    for (const step of steps) {
      if (step.status === 'completed') {
        completedSteps.push({
          oldTaskId: task.id,
          taskTitle: task.title,
          stepId: step.id,
          stepPath: step.path,
          status: 'completed',
          nodeId: node?.program_node_id,
        });
      } else if (step.status === 'current' || step.status === 'pending') {
        pendingSteps.push({
          taskId: task.id,
          taskTitle: task.title,
          stepId: step.id,
          stepPath: step.path,
        });
      }
    }
  }

  return {
    scope: { programId, nodeId },
    programTitle: prog.title,
    completedSteps,
    pendingSteps,
    activeTaskCount: activeCount,
    completedTaskCount: completedCount,
  };
}

/** Execute rebuild: cancel active tasks, reset node(s) to pending. */
export function executeRebuild(programId: string, nodeId?: string): { cancelled: number; resetNodes: string[] } {
  let sessions: any[];
  if (nodeId) {
    sessions = db.prepare("SELECT * FROM sessions WHERE program_id = ? AND program_node_id = ?").all(programId, nodeId) as any[];
  } else {
    sessions = db.prepare("SELECT * FROM sessions WHERE program_id = ?").all(programId) as any[];
  }

  const sessionIds = sessions.map((s: any) => s.session_id);
  if (sessionIds.length === 0) return { cancelled: 0, resetNodes: [] };

  const placeholders = sessionIds.map(() => '?').join(',');

  // Cancel all active tasks under these sessions
  const result = db.prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE session_id IN (${placeholders}) AND status = 'active'`
  ).run(now(), ...sessionIds);

  // Reset affected nodes to pending
  const resetNodes: string[] = [];
  if (nodeId) {
    db.prepare("UPDATE program_nodes SET status = 'pending', session_id = NULL, completed_at = NULL, node_key_hash = NULL WHERE node_id = ?")
      .run(nodeId);
    resetNodes.push(nodeId);
  } else {
    const nodes = db.prepare("SELECT node_id FROM program_nodes WHERE program_id = ? AND status != 'pending'").all(programId) as any[];
    for (const n of nodes) {
      db.prepare("UPDATE program_nodes SET status = 'pending', session_id = NULL, completed_at = NULL, node_key_hash = NULL WHERE node_id = ?")
        .run(n.node_id);
      resetNodes.push(n.node_id);
    }
    db.prepare("UPDATE programs SET status = 'active', updated_at = ? WHERE program_id = ?").run(now(), programId);
  }

  return { cancelled: result.changes, resetNodes };
}

/** Finalize program: check all nodes complete. */
export function finalizeProgram(programId: string): { ok: boolean; pending: ProgramNodeInfo[] } {
  const nodes = db.prepare("SELECT * FROM program_nodes WHERE program_id = ? AND status != 'completed'").all(programId) as any[];
  if (nodes.length > 0) {
    return {
      ok: false,
      pending: nodes.map((n: any) => ({
        nodeId: n.node_id, title: n.title, description: n.description,
        orderIndex: n.order_index, status: n.status, sessionId: n.session_id,
      })),
    };
  }
  db.prepare("UPDATE programs SET status = 'completed', updated_at = ? WHERE program_id = ?").run(now(), programId);
  return { ok: true, pending: [] };
}
