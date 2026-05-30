import crypto from 'node:crypto';
import db from '../storage/db.js';
import { randomCode, generateNodeKey, hashKey } from './keys.js';

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

/** Create a new program from a plan (JSON array of nodes with optional dependsOn). */
export function createProgram(title: string, nodes: { id?: string; title: string; description?: string; dependsOn?: string[] }[]): ProgramInfo {
  const programId = `pgm_${randomCode(6)}`;
  const ts = now();

  db.prepare('INSERT INTO programs (program_id, title, status, total_nodes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(programId, title, 'active', nodes.length, ts, ts);

  const programNodes: ProgramNodeInfo[] = nodes.map((n, i) => {
    const nodeId = n.id ?? `pg_${programId}_${i + 1}`;
    db.prepare('INSERT INTO program_nodes (node_id, program_id, title, description, order_index, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nodeId, programId, n.title, n.description ?? null, i + 1, 'pending', ts);
    return { nodeId, title: n.title, description: n.description, orderIndex: i + 1, status: 'pending' };
  });

  return { programId, title, totalNodes: nodes.length, nodes: programNodes };
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

/** Start a program node — creates a new session bound to it. */
export function startProgramNode(programId: string, nodeId: string, sessionId: string): boolean {
  const node = db.prepare('SELECT * FROM program_nodes WHERE node_id = ? AND program_id = ?').get(nodeId, programId) as any;
  if (!node || node.status !== 'pending') return false;

  db.prepare("UPDATE program_nodes SET status = 'in_progress', session_id = ? WHERE node_id = ?")
    .run(sessionId, nodeId);

  db.prepare('UPDATE sessions SET program_id = ?, program_node_id = ? WHERE session_id = ?')
    .run(programId, nodeId, sessionId);

  return true;
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
