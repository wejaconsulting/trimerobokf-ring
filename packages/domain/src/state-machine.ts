import type { CloseRunStatus, StepStatus } from './enums.js';
import {
  WORKFLOW_STEPS,
  getStepDefinition,
  type WorkflowStepDefinition,
  type WorkflowStepKey,
} from './workflow-steps.js';

/**
 * The close-run state machine.
 *
 * This is deliberately a plain, pure module: the workflow *engine* (see
 * packages/workflow) owns persistence and execution, while the legal
 * transitions live here where they can be unit tested without a database.
 * That split is what makes a later move to Temporal a swap of the engine
 * rather than a rewrite of the domain.
 */

const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['running', 'not_implemented', 'skipped', 'blocked'],
  running: ['completed', 'blocked', 'failed', 'not_implemented'],
  // Terminal-for-this-attempt states that a retry may legitimately reopen.
  blocked: ['pending', 'running', 'completed'],
  failed: ['pending', 'running'],
  not_implemented: ['pending', 'running'],
  completed: [],
  skipped: ['pending'],
};

const RUN_TRANSITIONS: Readonly<Record<CloseRunStatus, readonly CloseRunStatus[]>> = {
  pending: ['running', 'failed'],
  running: ['awaiting_review', 'completed', 'blocked', 'failed'],
  awaiting_review: ['running', 'completed', 'blocked', 'failed'],
  blocked: ['running', 'failed'],
  completed: [],
  failed: ['pending', 'running'],
};

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return from === to || (STEP_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new InvalidTransitionError(`Illegal step transition: ${from} -> ${to}`);
  }
}

export function canTransitionRun(from: CloseRunStatus, to: CloseRunStatus): boolean {
  return from === to || (RUN_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertRunTransition(from: CloseRunStatus, to: CloseRunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidTransitionError(`Illegal close run transition: ${from} -> ${to}`);
  }
}

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
}

export interface StepState {
  readonly stepKey: WorkflowStepKey;
  readonly status: StepStatus;
}

/**
 * Settled = this step has finished an attempt, whatever the verdict.
 *
 * `blocked` counts as settled on purpose: a downstream gate such as
 * `final_control` exists precisely to report *why* the period cannot close, and
 * it can only do that if a blocked predecessor still lets it run. Steps guard
 * their own preconditions, so a step whose inputs are genuinely missing reports
 * that itself rather than being skipped silently.
 */
export const SETTLED_STEP_STATUSES: readonly StepStatus[] = [
  'completed',
  'not_implemented',
  'skipped',
  'blocked',
];

export function isSettled(status: StepStatus | undefined): boolean {
  return status !== undefined && SETTLED_STEP_STATUSES.includes(status);
}

/** A step is runnable when all of its dependencies have reached a settled state. */
export function isRunnable(step: WorkflowStepDefinition, states: readonly StepState[]): boolean {
  const byKey = new Map(states.map((s) => [s.stepKey, s.status]));
  return step.dependsOn.every((dep) => isSettled(byKey.get(dep)));
}

export function nextRunnableSteps(states: readonly StepState[]): WorkflowStepDefinition[] {
  const byKey = new Map(states.map((s) => [s.stepKey, s.status]));
  return WORKFLOW_STEPS.filter(
    (def) => byKey.get(def.key) === 'pending' && isRunnable(def, states),
  );
}

export interface CompletionAssessment {
  readonly canComplete: boolean;
  readonly blockingSteps: readonly WorkflowStepKey[];
  readonly blockingFindingCount: number;
  readonly reasons: readonly string[];
}

/**
 * The final gate.
 *
 * A period may only be reported complete when every step that carries real
 * accounting work has completed AND no blocking finding is still open. An
 * unimplemented step that carries work keeps the period blocked - the system
 * must never report a period as complete because it simply did not look.
 */
export function assessCompletion(
  states: readonly StepState[],
  blockingFindingCount: number,
): CompletionAssessment {
  const reasons: string[] = [];
  const blockingSteps: WorkflowStepKey[] = [];

  for (const state of states) {
    const def = getStepDefinition(state.stepKey);
    if (!def.blocksCompletion) continue;
    if (state.status === 'completed') continue;

    blockingSteps.push(state.stepKey);
    if (state.status === 'not_implemented') {
      reasons.push(
        `Steget "${def.labelSv}" är inte implementerat och bär verkligt bokföringsarbete.`,
      );
    } else {
      reasons.push(`Steget "${def.labelSv}" har status ${state.status}.`);
    }
  }

  if (blockingFindingCount > 0) {
    reasons.push(`${blockingFindingCount} blockerande avvikelse(r) är fortfarande öppna.`);
  }

  return {
    canComplete: blockingSteps.length === 0 && blockingFindingCount === 0,
    blockingSteps,
    blockingFindingCount,
    reasons,
  };
}

/** Derives the run status from its steps, used after every step transition. */
export function deriveRunStatus(
  states: readonly StepState[],
  blockingFindingCount: number,
): CloseRunStatus {
  if (states.some((s) => s.status === 'failed')) return 'failed';
  if (states.some((s) => s.status === 'running')) return 'running';

  const assessment = assessCompletion(states, blockingFindingCount);
  if (assessment.canComplete) return 'completed';

  const allSettled = states.every(
    (s) =>
      s.status === 'completed' ||
      s.status === 'not_implemented' ||
      s.status === 'skipped' ||
      s.status === 'blocked',
  );
  if (!allSettled) return 'running';

  return blockingFindingCount > 0 ? 'awaiting_review' : 'blocked';
}
