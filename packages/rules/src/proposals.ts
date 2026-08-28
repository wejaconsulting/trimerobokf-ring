import {
  type DecisionGates,
  type DecisionOutcome,
  type DecisionSignals,
  type FindingDraft,
  type IsoDate,
  type Ore,
  decide,
  isMaterial,
  materialitySignal,
  periodEnd,
} from '@trimeros/domain';
import type { RuleContext } from './context.js';
import { NEUTRAL_GATES, NEUTRAL_SIGNALS } from './emit.js';
import { isPeriodLocked } from './engine.js';

/**
 * Booking proposals.
 *
 * A finding says "something is off". A proposal says "here is the correction,
 * and here is how confident the system is in *the correction*". The two are
 * scored independently on purpose: a high-severity finding can have a
 * completely routine fix, and the consultant should see that.
 *
 * Nothing here talks to Fortnox. The workflow turns a proposal into a
 * simulated request via `simulateVoucherCreate`.
 */

export interface ProposalRowDraft {
  readonly account: number;
  readonly debit: Ore;
  readonly credit: Ore;
  readonly description: string;
  readonly costCenter: string | null;
  readonly project: string | null;
  readonly vatCode: string | null;
}

export interface ProposalDraft {
  readonly findingDeduplicationKey: string;
  readonly series: string;
  readonly transactionDate: IsoDate;
  readonly description: string;
  readonly rows: readonly ProposalRowDraft[];
  readonly decision: DecisionOutcome;
  /** Why this correction is being proposed, in the consultant's language. */
  readonly rationale: string;
}

/** Deterministic client rules the proposal generator is allowed to act on. */
export interface DimensionRule {
  readonly kind: 'dimension_requirement';
  readonly account: number;
  readonly costCenter: string;
}

export interface AccrualRule {
  readonly kind: 'recurring_cost';
  readonly supplierNumber: string;
  readonly account: number;
  /** Account for the accrued liability, e.g. 2990 upplupna kostnader. */
  readonly accrualAccount: number;
}

export type ProposalRule = DimensionRule | AccrualRule;

export function generateProposals(
  ctx: RuleContext,
  findings: readonly FindingDraft[],
  rules: readonly ProposalRule[],
): ProposalDraft[] {
  const out: ProposalDraft[] = [];
  const periodLocked = isPeriodLocked(ctx);
  const lastDay = periodEnd(ctx.period);

  for (const finding of findings) {
    if (finding.type === 'validation.missing_required_dimension' || finding.type === 'anomaly.missing_cost_center_or_project') {
      const account = finding.subject.accountNumber;
      const rule = rules.find(
        (r): r is DimensionRule => r.kind === 'dimension_requirement' && r.account === account,
      );
      if (!rule || account === undefined) continue;

      const amount = Math.abs(finding.amount);
      out.push(
        buildProposal({
          finding,
          periodLocked,
          policy: ctx.policy,
          amount,
          series: 'A',
          transactionDate: lastDay,
          description: `Omkontering kostnadsställe konto ${account}`,
          rationale: `Klientregeln för konto ${account} anger kostnadsställe ${rule.costCenter}. Omkonteringen flyttar beloppet till rätt dimension utan att påverka resultatet.`,
          rows: [
            {
              account,
              debit: amount,
              credit: 0,
              description: `Omkontering till kostnadsställe ${rule.costCenter}`,
              costCenter: rule.costCenter,
              project: null,
              vatCode: null,
            },
            {
              account,
              debit: 0,
              credit: amount,
              description: 'Återföring rad utan kostnadsställe',
              costCenter: null,
              project: null,
              vatCode: null,
            },
          ],
          // A dimension correction is a pure reclassification: the books stay
          // balanced, no VAT is touched, and the source document is unchanged.
          signals: {},
          gates: { deterministicRuleMatched: true, validationsPassed: true },
        }),
      );
      continue;
    }

    if (finding.type === 'anomaly.missing_recurring_cost') {
      const supplierNumber = finding.subject.supplierNumber;
      const account = finding.subject.accountNumber;
      const rule = rules.find(
        (r): r is AccrualRule =>
          r.kind === 'recurring_cost' &&
          r.supplierNumber === supplierNumber &&
          r.account === account,
      );
      if (!rule || account === undefined) continue;

      const amount = Math.abs(finding.amount);
      out.push(
        buildProposal({
          finding,
          periodLocked,
          policy: ctx.policy,
          amount,
          series: 'A',
          transactionDate: lastDay,
          description: `Periodisering saknad återkommande kostnad ${supplierNumber}`,
          rationale: `Kostnaden har återkommit i nästan varje historisk period men saknas i ${ctx.period}. Förslaget periodiserar medianbeloppet mot upplupna kostnader i väntan på fakturan.`,
          rows: [
            {
              account,
              debit: amount,
              credit: 0,
              description: `Upplupen kostnad ${supplierNumber}`,
              costCenter: null,
              project: null,
              vatCode: null,
            },
            {
              account: rule.accrualAccount,
              debit: 0,
              credit: amount,
              description: `Upplupen kostnad ${supplierNumber}`,
              costCenter: null,
              project: null,
              vatCode: null,
            },
          ],
          // The invoice itself is missing, so documentation is incomplete and the
          // amount is an estimate from history rather than an observed fact.
          signals: { documentCompleteness: 0.2, amountConsistency: 0.6 },
          gates: { requiredDocumentationPresent: false, deterministicRuleMatched: true },
        }),
      );
    }
  }

  return out;
}

interface BuildProposalInput {
  readonly finding: FindingDraft;
  readonly periodLocked: boolean;
  readonly policy: RuleContext['policy'];
  readonly amount: Ore;
  readonly series: string;
  readonly transactionDate: IsoDate;
  readonly description: string;
  readonly rationale: string;
  readonly rows: readonly ProposalRowDraft[];
  readonly signals: Partial<DecisionSignals>;
  readonly gates: Partial<DecisionGates>;
}

function buildProposal(input: BuildProposalInput): ProposalDraft {
  const signals: DecisionSignals = {
    ...NEUTRAL_SIGNALS,
    ...input.signals,
    materiality:
      input.signals.materiality ?? materialitySignal(input.amount, input.policy.materialityThreshold),
  };

  const gates: DecisionGates = {
    ...NEUTRAL_GATES,
    ...input.gates,
    periodOpen: !input.periodLocked,
    periodLocked: input.periodLocked,
    materialAmount: isMaterial(input.amount, input.policy.materialityThreshold),
    withinAmountLimit: Math.abs(input.amount) <= input.policy.automationAmountLimit,
  };

  return {
    findingDeduplicationKey: input.finding.deduplicationKey,
    series: input.series,
    transactionDate: input.transactionDate,
    description: input.description,
    rows: input.rows,
    decision: decide(signals, gates),
    rationale: input.rationale,
  };
}

/** A proposal must balance before it may be shown, let alone simulated. */
export function proposalBalances(proposal: ProposalDraft): boolean {
  const debit = proposal.rows.reduce((a, r) => a + r.debit, 0);
  const credit = proposal.rows.reduce((a, r) => a + r.credit, 0);
  return debit === credit;
}
