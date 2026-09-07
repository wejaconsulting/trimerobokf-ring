import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  assertStepTransition,
  assessCompletion,
  canTransitionRun,
  canTransitionStep,
  deriveRunStatus,
  isRunnable,
  nextRunnableSteps,
  type StepState,
} from './state-machine.js';
import { WORKFLOW_STEPS, getStepDefinition } from './workflow-steps.js';

function allSteps(status: StepState['status']): StepState[] {
  return WORKFLOW_STEPS.map((s) => ({ stepKey: s.key, status }));
}

describe('close run state machine', () => {
  it('allows pending -> running -> completed and refuses to reopen a completed step', () => {
    expect(canTransitionStep('pending', 'running')).toBe(true);
    expect(canTransitionStep('running', 'completed')).toBe(true);
    expect(canTransitionStep('completed', 'running')).toBe(false);
    expect(() => assertStepTransition('completed', 'pending')).toThrow(InvalidTransitionError);
  });

  it('refuses to reopen a completed run', () => {
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(canTransitionRun('running', 'awaiting_review')).toBe(true);
  });

  it('only offers steps whose dependencies have settled', () => {
    const states = allSteps('pending');
    const runnable = nextRunnableSteps(states).map((s) => s.key);
    expect(runnable).toEqual(['agent_readiness']);

    const afterReadiness = states.map((s) =>
      s.stepKey === 'agent_readiness' ? { ...s, status: 'completed' as const } : s,
    );
    expect(nextRunnableSteps(afterReadiness).map((s) => s.key)).toContain('completeness_check');
  });

  it('treats a blocked dependency as settled so downstream gates can still report', () => {
    const states = allSteps('completed').map((s) =>
      s.stepKey === 'human_review' ? { ...s, status: 'blocked' as const } : s,
    );
    expect(isRunnable(getStepDefinition('final_control'), states)).toBe(true);
  });
});

describe('period completion gate', () => {
  it('refuses completion while an unimplemented step carries accounting work', () => {
    const states = allSteps('completed').map((s) =>
      s.stepKey === 'bank_and_tax_account_transactions'
        ? { ...s, status: 'not_implemented' as const }
        : s,
    );
    const assessment = assessCompletion(states, 0);
    expect(assessment.canComplete).toBe(false);
    expect(assessment.blockingSteps).toContain('bank_and_tax_account_transactions');
    expect(assessment.reasons.join(' ')).toContain('inte implementerat');
  });

  it('allows an unimplemented step that carries no accounting work', () => {
    const states = allSteps('completed').map((s) =>
      s.stepKey === 'income_statement_analysis' ? { ...s, status: 'not_implemented' as const } : s,
    );
    expect(assessCompletion(states, 0).canComplete).toBe(true);
  });

  it('refuses completion while a blocking finding is open', () => {
    const assessment = assessCompletion(allSteps('completed'), 1);
    expect(assessment.canComplete).toBe(false);
    expect(assessment.blockingFindingCount).toBe(1);
  });

  it('completes only when nothing blocks', () => {
    expect(assessCompletion(allSteps('completed'), 0).canComplete).toBe(true);
    expect(deriveRunStatus(allSteps('completed'), 0)).toBe('completed');
  });

  it('reports awaiting_review when everything settled but findings remain', () => {
    const states = allSteps('completed').map((s) =>
      s.stepKey === 'human_review' ? { ...s, status: 'blocked' as const } : s,
    );
    expect(deriveRunStatus(states, 3)).toBe('awaiting_review');
  });

  it('reports failed as soon as any step failed', () => {
    const states = allSteps('completed').map((s) =>
      s.stepKey === 'general_ledger_review' ? { ...s, status: 'failed' as const } : s,
    );
    expect(deriveRunStatus(states, 0)).toBe('failed');
  });
});

describe('workflow step definitions', () => {
  it('declares all 14 steps with unique, ordered keys', () => {
    expect(WORKFLOW_STEPS).toHaveLength(14);
    expect(new Set(WORKFLOW_STEPS.map((s) => s.key)).size).toBe(14);
    expect(WORKFLOW_STEPS.map((s) => s.order)).toEqual([...Array(14)].map((_u, i) => i + 1));
  });

  it('gives every step a Swedish label and description for the consultant', () => {
    for (const step of WORKFLOW_STEPS) {
      expect(step.labelSv.length).toBeGreaterThan(3);
      expect(step.descriptionSv.length).toBeGreaterThan(20);
      // The review console is Swedish throughout; the English description is
      // developer-facing and must not be what a consultant reads.
      expect(step.descriptionSv).not.toBe(step.description);
    }
  });

  it('only depends on steps that come earlier', () => {
    const orderByKey = new Map(WORKFLOW_STEPS.map((s) => [s.key, s.order]));
    for (const step of WORKFLOW_STEPS) {
      for (const dep of step.dependsOn) {
        expect(orderByKey.get(dep)!).toBeLessThan(step.order);
      }
    }
  });
});
