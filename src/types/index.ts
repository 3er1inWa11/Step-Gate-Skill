// ============================================================================
// Agent Step Gate — Core Types
// Phase 1 MVP: Step Ledger + Key Gate data model
// ============================================================================

// ---------------------------------------------------------------------------
// Plan / Step domain types
// ---------------------------------------------------------------------------

/** Nested step node — input format for gate_start_plan */
export interface PlanNode {
  title: string;
  children?: PlanNode[];
}

/** Leaf step after flattening the nested plan (one row in steps table) */
export interface LeafStep {
  id: string;
  taskId: string;
  parentPath: string | null;
  title: string;
  path: string;
  orderIndex: number;
  status: 'pending' | 'current' | 'completed';
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
  status: 'active' | 'completed';
  currentIndex: number;
  totalSteps: number;
  finalKeyHash: string | null;
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
  status: 'pending' | 'current' | 'completed';
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
  currentStep: CurrentStepInfo;
  stepKey: string;
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
  currentStep: CurrentStepInfo | null;
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
  nextStep?: CurrentStepInfo;
  nextStepKey?: string;
  allStepsCompleted?: boolean;
  finalKey?: string;
  error?: string;
  message?: string;
  currentStep?: CurrentStepInfo;
}

// ---------------------------------------------------------------------------
// gate_finalize
// ---------------------------------------------------------------------------

export interface GateFinalizeInput {
  taskId: string;
  finalKey: string;
}

export interface GateFinalizeOutput {
  accepted: boolean;
  status?: string;
  message?: string;
  currentStep?: CurrentStepInfo;
}
