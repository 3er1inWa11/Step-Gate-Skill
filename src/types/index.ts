// ============================================================================
// Agent Step Gate — Core Types
// Phase 2: DAG step dependencies, multi-step support, multi-task support
// ============================================================================

// ---------------------------------------------------------------------------
// Plan / Step domain types
// ---------------------------------------------------------------------------

/** Nested step node — input format for gate_start_plan */
export interface PlanNode {
  id?: string;
  title: string;
  children?: PlanNode[];
  dependsOn?: string[];
  /** Old key proving this step was completed in a previous task */
  skipKey?: string;
  /** The taskId from the previous (cancelled) task where skipKey was used */
  skipTaskId?: string;
}

/** Leaf step after flattening the nested plan (one row in steps table) */
export interface LeafStep {
  id: string;
  taskId: string;
  parentPath: string | null;
  title: string;
  path: string;
  orderIndex: number;
  dependsOn: string[];
  status: 'pending' | 'current' | 'completed' | 'skipped';
  completedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

/** Row shape for the tasks table */
export interface TaskRow {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'cancelled';
  currentIndex: number;
  totalSteps: number;
  finalKeyHash: string | null;
  programId: string | null;
  programNodeId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for the steps table (includes step_key_hash) */
export interface StepRow {
  id: string;
  taskId: string;
  parentPath: string | null;
  title: string;
  path: string;
  orderIndex: number;
  dependsOn: string[];
  status: 'pending' | 'current' | 'completed' | 'skipped';
  stepKeyHash: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Row shape for the events table */
export interface EventRow {
  id: string;
  taskId: string;
  stepId: string | null;
  eventType: string;
  payload: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Shared sub-types used across tool I/O
// ---------------------------------------------------------------------------

/** Snapshot of the currently-active step returned by several tools */
export interface CurrentStepInfo {
  stepId: string;
  path: string;
  index: number;
  total: number;
}

// ---------------------------------------------------------------------------
// gate_start_plan
// ---------------------------------------------------------------------------

export interface GateStartPlanInput {
  title: string;
  steps: PlanNode[];
}

export interface GateStartPlanOutput {
  taskId: string;
  status: 'active';
  sessionId: string;
  currentSteps: CurrentStepInfo[];
  stepKeys: Record<string, string>;
}

// ---------------------------------------------------------------------------
// gate_current
// ---------------------------------------------------------------------------

export interface GateCurrentInput {
  taskId: string;
}

export interface GateCurrentOutput {
  taskId: string;
  status: string;
  currentSteps: CurrentStepInfo[];
}

// ---------------------------------------------------------------------------
// gate_checkpoint
// ---------------------------------------------------------------------------

export interface GateCheckpointInput {
  taskId: string;
  stepId: string;
  stepKey: string;
}

export interface GateCheckpointOutput {
  accepted: boolean;
  completedStep?: { stepId: string; path: string };
  nextSteps?: CurrentStepInfo[];
  nextStepKeys?: Record<string, string>;
  allStepsCompleted?: boolean;
  taskKey?: string;
  error?: string;
  message?: string;
  currentStep?: CurrentStepInfo;
  pendingSteps?: CurrentStepInfo[];
}

// ---------------------------------------------------------------------------
// gate_finalize
// ---------------------------------------------------------------------------

export interface GateFinalizeInput {
  taskId: string;
  taskKey: string;
}

export interface GateFinalizeOutput {
  accepted: boolean;
  status?: string;
  message?: string;
  currentStep?: CurrentStepInfo;
  pendingSteps?: CurrentStepInfo[];
  nodeCompleted?: { nodeId: string; programId: string; nodeKey: string };
  programCompleted?: { programId: string };
}

// ---------------------------------------------------------------------------
// gate_active_task
// ---------------------------------------------------------------------------

export interface GateActiveTaskOutput {
  sessionId: string;
  activeTasks: Array<{
    taskId: string;
    title: string;
    status: string;
    totalSteps: number;
    completedSteps: number;
    currentSteps: CurrentStepInfo[];
  }>;
}

// ---------------------------------------------------------------------------
// gate_cancel_task
// ---------------------------------------------------------------------------

export interface GateCancelTaskInput {
  taskId: string;
}

export interface GateCancelTaskOutput {
  accepted: boolean;
  message: string;
}
