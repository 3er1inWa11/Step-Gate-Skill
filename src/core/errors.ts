// ============================================================================
// Agent Step Gate — Error codes & GateError class
// Phase 1 MVP
// ============================================================================

import type { CurrentStepInfo } from '../types/index.js';

// ---------------------------------------------------------------------------
// Error code enum
// ---------------------------------------------------------------------------

export enum GateErrorCode {
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',
  TASK_ALREADY_COMPLETED = 'TASK_ALREADY_COMPLETED',
  NO_STEPS = 'NO_STEPS',
  INVALID_CURRENT_STEP = 'INVALID_CURRENT_STEP',
  INVALID_STEP_KEY = 'INVALID_STEP_KEY',
  INVALID_FINAL_KEY = 'INVALID_FINAL_KEY',
  PLAN_SCHEMA_INVALID = 'PLAN_SCHEMA_INVALID',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

// ---------------------------------------------------------------------------
// GateError — structured error with optional current-step context
// ---------------------------------------------------------------------------

export class GateError extends Error {
  code: GateErrorCode;
  currentStep?: CurrentStepInfo;

  constructor(code: GateErrorCode, message: string, currentStep?: CurrentStepInfo) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.currentStep = currentStep;
  }
}
