import type { StepStatus, WorkflowStepKey } from '@trimeros/domain';

/**
 * The workflow engine boundary.
 *
 * The engine interface is deliberately narrow and free of any Temporal or
 * database concept. Phase 1 ships `DatabaseWorkflowEngine`, a state machine
 * whose entire state lives in `close_run_steps`; a Temporal implementation
 * would satisfy the same interface with the step handlers unchanged.
 * See docs/architecture.md, "Workflow engine: why not Temporal yet".
 */

export interface StartCloseRunInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly periodKey: string;
  /** Supplied by the caller so a retry reuses the same run instead of forking. */
  readonly correlationId?: string;
}

export interface CloseRunSummary {
  readonly closeRunId: string;
  readonly status: string;
  readonly steps: readonly { readonly stepKey: WorkflowStepKey; readonly status: StepStatus; readonly message: string | null }[];
  readonly findingCount: number;
  readonly blockingFindingCount: number;
  readonly reviewCount: number;
  readonly manualCount: number;
  readonly clearItemCount: number;
  readonly canComplete: boolean;
  readonly reasons: readonly string[];
}

export interface WorkflowEngine {
  startCloseRun(input: StartCloseRunInput): Promise<{ closeRunId: string }>;
  executeCloseRun(tenantId: string, closeRunId: string): Promise<CloseRunSummary>;
  getSummary(tenantId: string, closeRunId: string): Promise<CloseRunSummary>;
}

export interface StepOutcome {
  readonly status: StepStatus;
  readonly reasonCode?: string;
  readonly message?: string;
}
