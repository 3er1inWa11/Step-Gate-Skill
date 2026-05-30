import db from '../storage/db.js';

function now(): string { return new Date().toISOString(); }

export interface ReconcileReport {
  timestamp: string;
  scope: { programId?: string };
  summary: {
    totalPrograms: number;
    totalNodes: number;
    totalTasks: number;
    totalSteps: number;
    healthy: number;
    stale: number;
    orphan: number;
    drift: number;
  };
  orphans: Array<{
    type: 'step_orphan' | 'step_stale';
    stepId: string;
    taskId: string;
    path: string;
    detail: string;
  }>;
  staleTasks: Array<{
    taskId: string;
    title: string;
    status: string;
    sessionId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  drifts: Array<{
    type: 'task_done_node_pending' | 'task_active_node_done';
    detail: string;
  }>;
  suggestions: string[];
}

export function reconcile(programId?: string): ReconcileReport {
  const report: ReconcileReport = {
    timestamp: now(),
    scope: { programId },
    summary: { totalPrograms: 0, totalNodes: 0, totalTasks: 0, totalSteps: 0, healthy: 0, stale: 0, orphan: 0, drift: 0 },
    orphans: [],
    staleTasks: [],
    drifts: [],
    suggestions: [],
  };

  // ---- 1. Count totals ----
  const progFilter = programId ? 'WHERE program_id = ?' : '';
  const progParams = programId ? [programId] : [];

  report.summary.totalPrograms = (db.prepare(`SELECT COUNT(*) as c FROM programs ${progFilter}`).get(...progParams) as any).c;
  report.summary.totalNodes = (db.prepare(`SELECT COUNT(*) as c FROM program_nodes ${progFilter}`).get(...progParams) as any).c;

  // For tasks/steps, scope by program's sessions if programId given
  let taskFilter = '';
  let taskParams: string[] = [];
  if (programId) {
    const sessions = db.prepare('SELECT session_id FROM sessions WHERE program_id = ?').all(programId) as any[];
    const sids = sessions.map((s: any) => s.session_id);
    if (sids.length > 0) {
      const ph = sids.map(() => '?').join(',');
      taskFilter = `WHERE session_id IN (${ph})`;
      taskParams = sids;
    } else {
      taskFilter = "WHERE 1=0";
    }
  }

  report.summary.totalTasks = (db.prepare(`SELECT COUNT(*) as c FROM tasks ${taskFilter}`).get(...taskParams) as any).c;
  if (report.summary.totalTasks > 0) {
    const steps = db.prepare(`SELECT COUNT(*) as c FROM steps WHERE task_id IN (SELECT id FROM tasks ${taskFilter})`).get(...taskParams) as any;
    report.summary.totalSteps = steps.c;
  }

  // ---- 2. Find orphan/stale steps ----
  // Step whose task is cancelled or doesn't exist
  const orphanSteps = db.prepare(`
    SELECT s.id, s.task_id, s.path, s.status, s.completed_at
    FROM steps s
    LEFT JOIN tasks t ON s.task_id = t.id
    WHERE t.id IS NULL OR t.status = 'cancelled'
  `).all() as any[];

  for (const s of orphanSteps) {
    report.orphans.push({
      type: 'step_orphan',
      stepId: s.id,
      taskId: s.task_id,
      path: s.path,
      detail: s.status === 'completed'
        ? `Step completed but task is gone/cancelled. Can serve as skipKey source.`
        : `Step is ${s.status} but its task no longer exists.`,
    });
    report.summary.orphan++;
  }

  // Steps with status 'current' but updated > 30 min ago (stale)
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const staleSteps = db.prepare(`
    SELECT s.id, s.task_id, s.path, t.updated_at
    FROM steps s
    JOIN tasks t ON s.task_id = t.id
    WHERE s.status = 'current' AND t.updated_at < ?
    ORDER BY t.updated_at ASC
  `).all(staleThreshold) as any[];

  for (const s of staleSteps) {
    report.orphans.push({
      type: 'step_stale',
      stepId: s.id,
      taskId: s.task_id,
      path: s.path,
      detail: `Step stuck in 'current' since ${s.updated_at}.`,
    });
  }

  // ---- 3. Find stale active tasks ----
  const staleTasks = db.prepare(`
    SELECT id, title, status, session_id, created_at, updated_at
    FROM tasks
    WHERE status = 'active' AND updated_at < ?
    ORDER BY updated_at ASC
  `).all(staleThreshold) as any[];

  for (const t of staleTasks) {
    report.staleTasks.push({
      taskId: t.id,
      title: t.title,
      status: t.status,
      sessionId: t.session_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    });
    report.summary.stale++;
  }

  // ---- 4. Completed steps in incomplete tasks ----
  const danglingCompletes = db.prepare(`
    SELECT s.id, s.task_id, s.path, t.status as task_status
    FROM steps s
    JOIN tasks t ON s.task_id = t.id
    WHERE s.status = 'completed' AND t.status = 'active'
  `).all() as any[];

  if (danglingCompletes.length > 0) {
    report.suggestions.push(`${danglingCompletes.length} completed step(s) exist in active tasks. Consider finalizing.`);
  }

  // ---- 5. Task completed but Node not refreshed ----
  const nodeDrifts = db.prepare(`
    SELECT pn.node_id, pn.program_id, pn.title, pn.status as node_status
    FROM program_nodes pn
    WHERE pn.status = 'in_progress'
  `).all() as any[];

  for (const nd of nodeDrifts) {
    // Check if all tasks under this node are completed
    const sessions = db.prepare('SELECT session_id FROM sessions WHERE program_node_id = ?').all(nd.node_id) as any[];
    if (sessions.length === 0) continue;
    const sids = sessions.map((s: any) => s.session_id);
    const ph = sids.map(() => '?').join(',');

    const allDone = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE session_id IN (${ph}) AND status != 'completed'
    `).get(...sids) as any;

    const anyActive = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE session_id IN (${ph}) AND status = 'active'
    `).get(...sids) as any;

    if (allDone.c === 0) {
      // All tasks done but node still in_progress — drift!
      report.drifts.push({
        type: 'task_done_node_pending',
        detail: `Node "${nd.title}" (${nd.node_id}): all tasks completed but node status is still '${nd.node_status}'. Run finalize on the last task to trigger auto-propagation.`,
      });
      report.summary.drift++;
    }

    if (anyActive.c === 0 && allDone.c === 0) {
      // No active, all completed, node not refreshed
      report.drifts.push({
        type: 'task_done_node_pending',
        detail: `Node "${nd.title}" (${nd.node_id}): all tasks done, node not refreshed.`,
      });
      if (report.summary.drift === 0) report.summary.drift++;
    }
  }

  // Also: task active but node already completed
  const revDrifts = db.prepare(`
    SELECT t.id as task_id, t.title as task_title, pn.node_id, pn.title as node_title
    FROM tasks t
    JOIN sessions s ON t.session_id = s.session_id
    JOIN program_nodes pn ON s.program_node_id = pn.node_id
    WHERE t.status = 'active' AND pn.status = 'completed'
  `).all() as any[];

  for (const rd of revDrifts) {
    report.drifts.push({
      type: 'task_active_node_done',
      detail: `Task "${rd.task_title}" (${rd.task_id}) is active but its Node "${rd.node_title}" is already completed.`,
    });
    report.summary.drift++;
  }

  // ---- 6. Recalculate node/program status ----
  const allNodes = programId
    ? db.prepare('SELECT * FROM program_nodes WHERE program_id = ?').all(programId) as any[]
    : db.prepare('SELECT * FROM program_nodes').all() as any[];

  // Detect drift: node that's in_progress but all tasks done — report only, do not mutate
  for (const node of allNodes) {
    if (node.status !== 'in_progress') continue;
    const sessions = db.prepare('SELECT session_id FROM sessions WHERE program_node_id = ?').all(node.node_id) as any[];
    if (sessions.length === 0) continue;
    const sids = sessions.map((s: any) => s.session_id);
    const ph = sids.map(() => '?').join(',');
    const pending = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE session_id IN (${ph}) AND status != 'completed'`).get(...sids) as any;
    if (pending.c === 0) {
      report.drifts.push({
        type: 'task_done_node_pending',
        detail: `Node "${node.title}" (${node.node_id}): all tasks done but node is in_progress. Run finalize on the last task to trigger auto-propagation.`,
      });
      report.summary.drift++;
      report.suggestions.push(`Node "${node.title}" (${node.node_id}) has all tasks complete but status is stuck. Re-run finalize on the last task to fix.`);
    }
  }

  // ---- 7. Build suggestions ----
  const activeCount = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'active'").get() as any).c;
  if (activeCount > 3) {
    report.suggestions.push(`${activeCount} active tasks. Consider reviewing for stale/inactive tasks with 'program rebuild --dry-run'.`);
  }
  if (report.orphans.length > 0) {
    report.suggestions.push(`${report.orphans.length} orphan/stale step(s) found. They can serve as skipKey sources or be cleaned up.`);
  }
  if (report.drifts.length > 0) {
    report.suggestions.push(`${report.drifts.length} state drift(s) found. Run finalize on affected tasks to propagate.`);
  }
  if (report.summary.totalTasks === 0) {
    report.suggestions.push('No tasks found. Create a plan with: node dist/cli.js start-plan ...');
  }

  report.summary.healthy = report.summary.totalTasks - report.summary.stale - report.summary.orphan;

  return report;
}
