import {
  type FindingDraft,
  type Ore,
  type Voucher,
  type VoucherRow,
  formatSek,
  isBalanceAccount,
  isResultAccount,
  periodKeyOf,
  relativeDeviation,
  voucherReference,
  voucherTotalDebit,
} from '@trimeros/domain';
import type { RuleContext } from './context.js';
import { type EmitEnvironment, emitFinding } from './emit.js';
import { type HistoryIndex, findRecurringCosts } from './history.js';
import { RULES } from './registry.js';

/**
 * The first set of anomaly rules.
 *
 * Every rule here is deterministic and explainable: it compares the current
 * period against a counted, inspectable history profile and states the numbers
 * behind its conclusion. No model is consulted to decide whether something is
 * anomalous.
 */

export interface AnomalyInput {
  readonly ctx: RuleContext;
  readonly env: EmitEnvironment;
  readonly history: HistoryIndex;
}

const VAT_ACCOUNT = 2641;
const AP_ACCOUNT = 2440;
const AR_ACCOUNT = 1510;
const OUTPUT_VAT_ACCOUNT = 2611;

function isCostRow(row: VoucherRow): boolean {
  return (
    row.account !== VAT_ACCOUNT &&
    row.account !== AP_ACCOUNT &&
    row.account !== AR_ACCOUNT &&
    row.account !== OUTPUT_VAT_ACCOUNT
  );
}

function costRows(voucher: Voucher): VoucherRow[] {
  return voucher.rows.filter((r) => isCostRow(r) && r.debit - r.credit !== 0);
}

function netOf(voucher: Voucher): Ore {
  return costRows(voucher).reduce<Ore>((a, r) => a + (r.debit - r.credit), 0);
}

/** 1. An account this supplier has never been booked against. */
export function ruleUnusualAccountForSupplier({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    const supplier = voucher.supplierNumber;
    if (!supplier) continue;
    const profile = history.suppliers.get(supplier);

    for (const row of costRows(voucher)) {
      const usedBefore = (profile?.accountCounts.get(row.account) ?? 0) > 0;
      if (usedBefore) continue;

      const known = profile && profile.totalPostings > 0;
      const usualAccounts = known
        ? [...profile.accountCounts.entries()].sort((a, b) => b[1] - a[1]).map(([acc, n]) => `${acc} (${n} ggr)`)
        : [];

      out.push(
        emitFinding(env, {
          rule: RULES.unusualAccountForSupplier,
          type: 'anomaly.unusual_account_for_supplier',
          severity: known ? 'medium' : 'low',
          subject: {
            voucherId: voucher.id,
            voucherRowId: row.id,
            accountNumber: row.account,
            supplierNumber: supplier,
          },
          amount: Math.abs(row.debit - row.credit),
          description: known
            ? `Konto ${row.account} har inte använts för denna leverantör tidigare.`
            : `Ny leverantör: ${supplier} saknar historik att jämföra mot.`,
          rationale: known
            ? `Leverantör ${supplier} har i historikfönstret bokförts på ${usualAccounts.join(', ')}, men denna verifikation använder konto ${row.account}.`
            : `Leverantör ${supplier} förekommer för första gången i historikfönstret på ${history.periods.length} perioder, så ingen kontohistorik finns att jämföra mot.`,
          suggestedAction: known
            ? 'Kontrollera mot underlaget att kontot är rätt, eller lägg upp en kontomappning för leverantören.'
            : 'Kontrollera underlaget och lägg upp en kontomappning för den nya leverantören.',
          evidence: [
            { kind: 'voucher_row', ref: row.id },
            { kind: 'history_window', ref: `supplier:${supplier}`, label: `${history.periods.length} perioder` },
          ],
          issueClass: 'unusual_account_for_supplier',
          signals: {
            historicalConsistency: known ? 0.1 : 0.3,
            counterpartyIdentityMatch: known ? 1 : 0.3,
            deterministicRuleMatch: 0,
          },
          gates: { deterministicRuleMatched: false },
        }),
      );
    }
  }
  return out;
}

/** 2. A VAT code that differs from what the account normally carries. */
export function ruleDeviatingVatCode({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    for (const row of costRows(voucher)) {
      if (!row.vatCode) continue;
      const dominant = history.dominantVatCodeByAccount.get(row.account);
      if (!dominant || dominant === row.vatCode) continue;

      out.push(
        emitFinding(env, {
          rule: RULES.deviatingVatCode,
          type: 'anomaly.deviating_vat_code',
          severity: 'medium',
          subject: {
            voucherId: voucher.id,
            voucherRowId: row.id,
            accountNumber: row.account,
            supplierNumber: voucher.supplierNumber ?? undefined,
          },
          amount: Math.abs(row.debit - row.credit),
          description: `Momskod ${row.vatCode} avviker på konto ${row.account}.`,
          rationale: `Konto ${row.account} har i historiken bokförts med momskod ${dominant}, men denna rad använder ${row.vatCode}.`,
          suggestedAction: 'Kontrollera momssatsen mot underlaget och rätta momskoden om den är fel.',
          evidence: [
            { kind: 'voucher_row', ref: row.id },
            { kind: 'history_window', ref: `account_vat:${row.account}`, label: dominant },
          ],
          issueClass: 'deviating_vat_code',
          signals: { vatConsistency: 0.15, historicalConsistency: 0.4, deterministicRuleMatch: 0 },
          gates: { deterministicRuleMatched: false, vatTreatmentUncertain: true },
        }),
      );
    }
  }
  return out;
}

/** 3. An amount far from this supplier's median. */
export function ruleUnusualAmount({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const threshold = ctx.policy.amountDeviationThreshold;

  for (const voucher of ctx.current.vouchers) {
    const supplier = voucher.supplierNumber;
    if (!supplier) continue;
    const profile = history.suppliers.get(supplier);
    if (!profile || profile.netAmounts.length < 3) continue;

    const net = netOf(voucher);
    if (net === 0) continue;
    const deviation = relativeDeviation(net, profile.medianNet);
    if (deviation <= threshold) continue;

    out.push(
      emitFinding(env, {
        rule: RULES.unusualAmount,
        type: 'anomaly.unusual_amount_for_supplier',
        severity: deviation > 2 ? 'high' : 'medium',
        subject: { voucherId: voucher.id, supplierNumber: supplier },
        amount: net,
        description: `Beloppet avviker ${(deviation * 100).toFixed(0)} % från leverantörens normalbelopp.`,
        rationale: `Leverantör ${supplier} har medianbeloppet ${formatSek(profile.medianNet)} över ${profile.netAmounts.length} tidigare bokföringar. Denna verifikation är ${formatSek(net)}.`,
        suggestedAction: 'Stäm av beloppet mot underlaget och kontrollera om det avser flera perioder.',
        evidence: [
          { kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) },
          {
            kind: 'history_window',
            ref: `supplier_amounts:${supplier}`,
            label: `median ${formatSek(profile.medianNet)}`,
          },
        ],
        issueClass: 'unusual_amount_for_supplier',
        signals: {
          amountConsistency: Math.max(0, 1 - deviation / 2),
          historicalConsistency: 0.35,
          deterministicRuleMatch: 0,
        },
        gates: { deterministicRuleMatched: false },
      }),
    );
  }
  return out;
}

/** 4. Two postings in the period that look like the same invoice. */
export function rulePossibleDuplicate({ ctx, env }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const groups = new Map<string, Voucher[]>();

  for (const voucher of ctx.current.vouchers) {
    if (!voucher.supplierNumber) continue;
    const key = `${voucher.supplierNumber}|${voucher.transactionDate}|${voucherTotalDebit(voucher)}`;
    groups.set(key, [...(groups.get(key) ?? []), voucher]);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    if (!first) continue;

    for (const voucher of rest) {
      out.push(
        emitFinding(env, {
          rule: RULES.possibleDuplicate,
          type: 'anomaly.possible_duplicate',
          severity: 'high',
          subject: { voucherId: voucher.id, supplierNumber: voucher.supplierNumber ?? undefined },
          amount: voucherTotalDebit(voucher),
          description: `Möjlig dubblett av ${voucherReference(first)}.`,
          rationale: `${voucherReference(first)} och ${voucherReference(voucher)} har samma leverantör (${voucher.supplierNumber}), samma datum (${voucher.transactionDate}) och samma belopp (${formatSek(voucherTotalDebit(voucher))}).`,
          suggestedAction: 'Kontrollera underlagen och makulera den ena bokföringen om det är en dubblett.',
          evidence: [
            { kind: 'voucher', ref: first.id, label: voucherReference(first) },
            { kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) },
          ],
          // Deliberately the same class as the duplicate-source-record validation.
          issueClass: 'duplicate_source_record',
          signals: { duplicateRisk: 0.05, deterministicRuleMatch: 0, reconciliationImpact: 0.3 },
          gates: { deterministicRuleMatched: false },
        }),
      );
    }
  }
  return out;
}

/** 5. No receipt or invoice attached. */
export function ruleMissingDocumentation({ ctx, env }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const invoiceHasFile = new Map(
    ctx.allSupplierInvoices.map((i) => [i.givenNumber, i.hasFileConnection]),
  );

  for (const voucher of ctx.current.vouchers) {
    // Vouchers generated by Fortnox modules from a customer invoice carry their
    // own documentation; only purchase-side and manual vouchers are checked.
    if (voucher.customerInvoiceNumber) continue;
    const documented =
      voucher.hasFileConnection ||
      (voucher.supplierInvoiceNumber
        ? (invoiceHasFile.get(voucher.supplierInvoiceNumber) ?? false)
        : false);
    if (documented) continue;

    out.push(
      emitFinding(env, {
        rule: RULES.missingDocumentation,
        type: 'anomaly.missing_documentation',
        severity: 'high',
        subject: {
          voucherId: voucher.id,
          supplierNumber: voucher.supplierNumber ?? undefined,
        },
        amount: voucherTotalDebit(voucher),
        description: `Verifikation ${voucherReference(voucher)} saknar underlag.`,
        rationale:
          'Ingen fil är kopplad till verifikationen i Fortnox och ingen dokumenterad leverantörsfaktura kunde matchas.',
        suggestedAction: 'Begär underlag från kunden och koppla det till verifikationen.',
        evidence: [{ kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) }],
        issueClass: 'missing_documentation',
        signals: { documentCompleteness: 0, deterministicRuleMatch: 0 },
        gates: { deterministicRuleMatched: false, requiredDocumentationPresent: false },
      }),
    );
  }
  return out;
}

/** 6. Missing cost center or project where the history normally has one. */
export function ruleMissingDimension({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const required = new Set(ctx.policy.costCenterRequiredAccounts);

  for (const voucher of ctx.current.vouchers) {
    for (const row of costRows(voucher)) {
      if (row.costCenter) continue;
      // Only interesting where the account is normally dimensioned.
      const usedBefore = (history.accountUsage.get(row.account) ?? 0) > 0;
      if (!required.has(row.account) && !usedBefore) continue;
      if (!required.has(row.account)) continue;

      out.push(
        emitFinding(env, {
          rule: RULES.missingDimension,
          type: 'anomaly.missing_cost_center_or_project',
          severity: 'low',
          subject: { voucherId: voucher.id, voucherRowId: row.id, accountNumber: row.account },
          amount: Math.abs(row.debit - row.credit),
          description: `Konto ${row.account} saknar kostnadsställe i ${voucherReference(voucher)}.`,
          rationale: `Konto ${row.account} bokförs normalt med kostnadsställe hos denna klient.`,
          suggestedAction: 'Komplettera raden med kostnadsställe.',
          evidence: [{ kind: 'voucher_row', ref: row.id }],
          // Same class as validateRequiredDimensions - one item for the consultant.
          issueClass: 'missing_dimension',
          signals: { dimensionConsistency: 0.1, deterministicRuleMatch: 0 },
          gates: { deterministicRuleMatched: false },
        }),
      );
    }
  }
  return out;
}

/** 7. The invoice belongs to a different period than the booking date. */
export function ruleWrongPeriod({ ctx, env }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const invoiceDates = new Map(ctx.allSupplierInvoices.map((i) => [i.givenNumber, i.invoiceDate]));

  for (const voucher of ctx.current.vouchers) {
    const number = voucher.supplierInvoiceNumber;
    if (!number) continue;
    const invoiceDate = invoiceDates.get(number);
    if (!invoiceDate) continue;

    const invoicePeriod = periodKeyOf(invoiceDate);
    const bookedPeriod = periodKeyOf(voucher.transactionDate);
    if (invoicePeriod === bookedPeriod) continue;

    out.push(
      emitFinding(env, {
        rule: RULES.wrongPeriod,
        type: 'anomaly.transaction_in_wrong_period',
        severity: 'medium',
        subject: {
          voucherId: voucher.id,
          supplierNumber: voucher.supplierNumber ?? undefined,
          invoiceId: number,
        },
        amount: voucherTotalDebit(voucher),
        description: `Faktura från ${invoicePeriod} är bokförd i ${bookedPeriod}.`,
        rationale: `Leverantörsfaktura ${number} är daterad ${invoiceDate} men verifikationen är bokförd ${voucher.transactionDate}.`,
        suggestedAction:
          'Bedöm om kostnaden ska periodiseras till rätt månad eller om bokföringsdatumet ska korrigeras.',
        evidence: [
          { kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) },
          { kind: 'supplier_invoice', ref: number, label: invoiceDate },
        ],
        issueClass: 'transaction_in_wrong_period',
        signals: { historicalConsistency: 0.5, reconciliationImpact: 0.4, deterministicRuleMatch: 0 },
        gates: { deterministicRuleMatched: false, requiresProfessionalJudgement: true },
      }),
    );
  }
  return out;
}

/** 8. A manual voucher on a rarely used account, or for a large amount. */
export function ruleManualVoucherUnusual({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const rareThreshold = 3;

  for (const voucher of ctx.current.vouchers) {
    if (!voucher.manual) continue;
    const total = voucherTotalDebit(voucher);
    const rareAccounts = costRows(voucher)
      .filter((r) => (history.accountUsage.get(r.account) ?? 0) < rareThreshold)
      .map((r) => r.account);
    const large = total >= ctx.policy.materialityThreshold;
    if (rareAccounts.length === 0 && !large) continue;

    const reasons = [
      rareAccounts.length > 0
        ? `konto ${rareAccounts.join(', ')} har använts färre än ${rareThreshold} gånger i historiken`
        : null,
      large ? `beloppet ${formatSek(total)} överstiger väsentlighetsgränsen` : null,
    ].filter(Boolean);

    out.push(
      emitFinding(env, {
        rule: RULES.manualVoucherUnusual,
        type: 'anomaly.manual_voucher_unusual',
        severity: large ? 'high' : 'medium',
        subject: {
          voucherId: voucher.id,
          ...(rareAccounts[0] !== undefined ? { accountNumber: rareAccounts[0] } : {}),
        },
        amount: total,
        description: `Manuell verifikation ${voucherReference(voucher)} avviker.`,
        rationale: `Verifikationen är manuellt registrerad i serie ${voucher.series} och ${reasons.join('; ')}.`,
        suggestedAction: 'Granska underlaget och bedömningen bakom den manuella verifikationen.',
        evidence: [{ kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) }],
        issueClass: 'manual_voucher_unusual',
        signals: {
          historicalConsistency: rareAccounts.length > 0 ? 0.2 : 0.6,
          deterministicRuleMatch: 0,
        },
        gates: { deterministicRuleMatched: false, requiresProfessionalJudgement: true },
      }),
    );
  }
  return out;
}

/** 9. A balance account where this supplier's history always used a result account. */
export function ruleBalanceInsteadOfResult({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    const supplier = voucher.supplierNumber;
    if (!supplier) continue;
    const profile = history.suppliers.get(supplier);
    if (!profile || !profile.alwaysResultAccount || profile.totalPostings < 3) continue;

    for (const row of costRows(voucher)) {
      if (!isBalanceAccount(row.account)) continue;

      const historicAccounts = [...profile.accountCounts.keys()].filter(isResultAccount);
      out.push(
        emitFinding(env, {
          rule: RULES.balanceInsteadOfResult,
          type: 'anomaly.balance_account_where_history_uses_result_account',
          severity: 'medium',
          subject: {
            voucherId: voucher.id,
            voucherRowId: row.id,
            accountNumber: row.account,
            supplierNumber: supplier,
          },
          amount: Math.abs(row.debit - row.credit),
          description: `Kostnad från ${supplier} är bokförd på balanskonto ${row.account}.`,
          rationale: `Leverantör ${supplier} har i historiken alltid bokförts mot resultatkonto (${historicAccounts.join(', ')}) i ${profile.totalPostings} bokföringar. Denna rad hamnar på balanskonto ${row.account}.`,
          suggestedAction:
            'Bedöm om posten är en riktig periodisering eller om den ska bokföras som kostnad i perioden.',
          evidence: [
            { kind: 'voucher_row', ref: row.id },
            { kind: 'history_window', ref: `supplier:${supplier}` },
          ],
          issueClass: 'balance_instead_of_result',
          signals: { historicalConsistency: 0.15, reconciliationImpact: 0.5, deterministicRuleMatch: 0 },
          gates: { deterministicRuleMatched: false, requiresProfessionalJudgement: true },
        }),
      );
    }
  }
  return out;
}

/** 10. A recurring monthly cost that is absent from this period. */
export function ruleMissingRecurringCost({ ctx, env, history }: AnomalyInput): FindingDraft[] {
  const recurring = findRecurringCosts(ctx.historyVouchers, history.periods);
  const present = new Set<string>();

  for (const voucher of ctx.current.vouchers) {
    if (!voucher.supplierNumber) continue;
    for (const row of costRows(voucher)) {
      present.add(`${voucher.supplierNumber}:${row.account}`);
    }
    present.add(`${voucher.supplierNumber}:*`);
  }

  const out: FindingDraft[] = [];
  for (const cost of recurring) {
    if (present.has(`${cost.supplierNumber}:${cost.account}`)) continue;
    // If the supplier appears at all this period, the account moved rather than
    // the cost going missing - that is the unusual-account rule's job.
    if (present.has(`${cost.supplierNumber}:*`)) continue;

    out.push(
      emitFinding(env, {
        rule: RULES.missingRecurringCost,
        type: 'anomaly.missing_recurring_cost',
        severity: 'high',
        subject: { supplierNumber: cost.supplierNumber, accountNumber: cost.account },
        amount: cost.medianNet,
        description: `Återkommande kostnad från ${cost.supplierNumber} saknas i ${ctx.period}.`,
        rationale: `Leverantör ${cost.supplierNumber} har bokförts på konto ${cost.account} i ${cost.periodsSeen} av ${cost.totalPeriods} historiska perioder, med medianbelopp ${formatSek(cost.medianNet)}. I ${ctx.period} finns ingen sådan bokföring.`,
        suggestedAction:
          'Kontrollera om fakturan saknas, är obokförd i inkorgen, eller om avtalet upphört. Överväg att periodisera kostnaden.',
        evidence: [
          {
            kind: 'history_window',
            ref: `recurring:${cost.supplierNumber}:${cost.account}`,
            label: `${cost.periodsSeen}/${cost.totalPeriods} perioder`,
          },
        ],
        issueClass: 'missing_recurring_cost',
        signals: {
          documentCompleteness: 0.2,
          historicalConsistency: 0.1,
          reconciliationImpact: 0.3,
          deterministicRuleMatch: 0,
        },
        gates: { deterministicRuleMatched: false, requiredDocumentationPresent: false },
      }),
    );
  }
  return out;
}

export const ALL_ANOMALY_RULES = [
  ruleUnusualAccountForSupplier,
  ruleDeviatingVatCode,
  ruleUnusualAmount,
  rulePossibleDuplicate,
  ruleMissingDocumentation,
  ruleMissingDimension,
  ruleWrongPeriod,
  ruleManualVoucherUnusual,
  ruleBalanceInsteadOfResult,
  ruleMissingRecurringCost,
] as const;
