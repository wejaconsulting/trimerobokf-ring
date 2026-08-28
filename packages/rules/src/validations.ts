import {
  type Account,
  type EvidenceRef,
  type FinancialYear,
  type FindingDraft,
  type IsoDate,
  type Ore,
  type Voucher,
  formatSek,
  voucherReference,
  voucherTotalCredit,
  voucherTotalDebit,
} from '@trimeros/domain';
import type { RuleContext } from './context.js';
import { type EmitEnvironment, emitFinding } from './emit.js';
import { RULES } from './registry.js';

/**
 * The mandatory deterministic validations.
 *
 * These are not heuristics. Every one of them is a rule the books must satisfy
 * before anything may be considered for automatic handling, and every finding
 * they produce is blocking.
 */

const INPUT_VAT_ACCOUNT = 2641;
/** Tolerance when checking VAT against a rate: 1 krona, to absorb rounding. */
const VAT_TOLERANCE_ORE = 100;

export interface ValidationInput {
  readonly ctx: RuleContext;
  readonly env: EmitEnvironment;
}

/** 1. Debit must equal credit. */
export function validateBalanced({ ctx, env }: ValidationInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const voucher of ctx.current.vouchers) {
    const debit = voucherTotalDebit(voucher);
    const credit = voucherTotalCredit(voucher);
    if (debit === credit) continue;
    out.push(
      emitFinding(env, {
        rule: RULES.balancedVoucher,
        type: 'validation.unbalanced_voucher',
        severity: 'critical',
        subject: { voucherId: voucher.id },
        amount: Math.abs(debit - credit),
        description: `Verifikation ${voucherReference(voucher)} balanserar inte.`,
        rationale: `Debet ${formatSek(debit)} skiljer sig från kredit ${formatSek(credit)} med ${formatSek(Math.abs(debit - credit))}.`,
        suggestedAction: 'Rätta verifikationen så att debet och kredit stämmer överens.',
        evidence: [{ kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) }],
        issueClass: 'unbalanced_voucher',
        signals: { deterministicRuleMatch: 0, reconciliationImpact: 0 },
        gates: { validationsPassed: false, requiresProfessionalJudgement: false },
      }),
    );
  }
  return out;
}

/** 2. Every account must exist in the chart and be active. */
export function validateAccounts({ ctx, env }: ValidationInput): FindingDraft[] {
  const byNumber = new Map<number, Account>(ctx.current.accounts.map((a) => [a.number, a]));
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    for (const row of voucher.rows) {
      const account = byNumber.get(row.account);
      if (account?.active) continue;
      const amount = Math.abs(row.debit - row.credit);
      out.push(
        emitFinding(env, {
          rule: RULES.accountsExist,
          type: 'validation.unknown_or_inactive_account',
          severity: 'critical',
          subject: { voucherId: voucher.id, voucherRowId: row.id, accountNumber: row.account },
          amount,
          description: account
            ? `Konto ${row.account} är spärrat men används i ${voucherReference(voucher)}.`
            : `Konto ${row.account} finns inte i kontoplanen.`,
          rationale: account
            ? `Kontot ${row.account} (${account.description}) är markerat som inaktivt i kontoplanen.`
            : `Kontot ${row.account} saknas i den hämtade kontoplanen för räkenskapsåret.`,
          suggestedAction: 'Bokför om raden på ett aktivt konto, eller aktivera kontot i Fortnox.',
          evidence: [
            { kind: 'voucher_row', ref: row.id },
            { kind: 'account', ref: String(row.account) },
          ],
          issueClass: 'invalid_account',
          signals: { deterministicRuleMatch: 0 },
          gates: { validationsPassed: false },
        }),
      );
    }
  }
  return out;
}

/** 3. The transaction date must fall inside an open financial year. */
export function validateFinancialYear({ ctx, env }: ValidationInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const voucher of ctx.current.vouchers) {
    if (findFinancialYear(ctx.financialYears, voucher.transactionDate)) continue;
    out.push(
      emitFinding(env, {
        rule: RULES.dateInFinancialYear,
        type: 'validation.date_outside_financial_year',
        severity: 'critical',
        subject: { voucherId: voucher.id },
        amount: voucherTotalDebit(voucher),
        description: `Verifikation ${voucherReference(voucher)} ligger utanför upplagt räkenskapsår.`,
        rationale: `Datumet ${voucher.transactionDate} täcks inte av något räkenskapsår som hämtats från Fortnox.`,
        suggestedAction: 'Lägg upp räkenskapsåret i Fortnox eller korrigera datumet.',
        evidence: [{ kind: 'voucher', ref: voucher.id }],
        issueClass: 'date_outside_financial_year',
        signals: { deterministicRuleMatch: 0 },
        gates: { validationsPassed: false, requiresProfessionalJudgement: true },
      }),
    );
  }
  return out;
}

export function findFinancialYear(
  years: readonly FinancialYear[],
  date: IsoDate,
): FinancialYear | undefined {
  return years.find((y) => y.fromDate <= date && date <= y.toDate);
}

/** 4. Nothing may be booked into a locked period. */
export function validatePeriodNotLocked({ ctx, env }: ValidationInput): FindingDraft[] {
  const lockedThrough = ctx.lockedThrough;
  if (!lockedThrough) return [];
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    if (voucher.transactionDate > lockedThrough) continue;
    out.push(
      emitFinding(env, {
        rule: RULES.periodNotLocked,
        type: 'validation.period_locked',
        severity: 'critical',
        subject: { voucherId: voucher.id },
        amount: voucherTotalDebit(voucher),
        description: `Verifikation ${voucherReference(voucher)} ligger i en låst period.`,
        rationale: `Fortnox rapporterar böckerna låsta till och med ${lockedThrough}, men verifikationen är daterad ${voucher.transactionDate}.`,
        suggestedAction:
          'Perioden är låst. Ändringen måste hanteras manuellt, med beslut om att låsa upp perioden eller bokföra i en öppen period.',
        evidence: [{ kind: 'voucher', ref: voucher.id }],
        issueClass: 'period_locked',
        signals: { deterministicRuleMatch: 0 },
        gates: { validationsPassed: false, periodOpen: false, periodLocked: true },
      }),
    );
  }
  return out;
}

/** 5. VAT amounts must correspond to an allowed rate. */
export function validateVat({ ctx, env }: ValidationInput): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const voucher of ctx.current.vouchers) {
    const vatRow = voucher.rows.find((r) => r.account === INPUT_VAT_ACCOUNT && r.debit > 0);
    if (!vatRow) continue;
    const net = voucher.rows
      .filter((r) => r.account !== INPUT_VAT_ACCOUNT && r.debit > 0 && r.account >= 1000)
      .reduce<Ore>((a, r) => a + r.debit, 0);
    if (net === 0) continue;

    const matches = ctx.policy.vatRates.some(
      (rate) => Math.abs(Math.round(net * rate) - vatRow.debit) <= VAT_TOLERANCE_ORE,
    );
    if (matches) continue;

    const impliedRate = vatRow.debit / net;
    out.push(
      emitFinding(env, {
        rule: RULES.vatPlausible,
        type: 'validation.implausible_vat',
        severity: 'high',
        subject: { voucherId: voucher.id, voucherRowId: vatRow.id, accountNumber: INPUT_VAT_ACCOUNT },
        amount: vatRow.debit,
        description: `Momsbeloppet i ${voucherReference(voucher)} motsvarar ingen tillåten momssats.`,
        rationale: `Ingående moms ${formatSek(vatRow.debit)} mot nettobelopp ${formatSek(net)} ger ${(impliedRate * 100).toFixed(1)} %, vilket inte matchar någon av de tillåtna satserna (${ctx.policy.vatRates.map((r) => `${r * 100} %`).join(', ')}).`,
        suggestedAction: 'Kontrollera momsbeloppet mot underlaget och rätta bokföringen.',
        evidence: [{ kind: 'voucher_row', ref: vatRow.id }],
        issueClass: 'implausible_vat',
        signals: { vatConsistency: 0, deterministicRuleMatch: 0 },
        gates: { validationsPassed: false, vatTreatmentUncertain: true },
      }),
    );
  }
  return out;
}

/** 6. Input VAT must never be claimed without documentation. */
export function validateInputVatDocumentation({ ctx, env }: ValidationInput): FindingDraft[] {
  if (!ctx.policy.requireDocumentationForInputVat) return [];
  const out: FindingDraft[] = [];

  const invoiceHasFile = new Map(
    ctx.allSupplierInvoices.map((i) => [i.givenNumber, i.hasFileConnection]),
  );

  for (const voucher of ctx.current.vouchers) {
    const vatRow = voucher.rows.find((r) => r.account === INPUT_VAT_ACCOUNT && r.debit > 0);
    if (!vatRow) continue;

    const documented =
      voucher.hasFileConnection ||
      (voucher.supplierInvoiceNumber
        ? (invoiceHasFile.get(voucher.supplierInvoiceNumber) ?? false)
        : false);
    if (documented) continue;

    out.push(
      emitFinding(env, {
        rule: RULES.inputVatDocumentation,
        type: 'validation.input_vat_without_documentation',
        severity: 'high',
        subject: {
          voucherId: voucher.id,
          voucherRowId: vatRow.id,
          accountNumber: INPUT_VAT_ACCOUNT,
          supplierNumber: voucher.supplierNumber ?? undefined,
        },
        amount: vatRow.debit,
        description: `Ingående moms ${formatSek(vatRow.debit)} är avdragen utan underlag i ${voucherReference(voucher)}.`,
        rationale:
          'Verifikationen saknar kopplad fil i Fortnox och den kopplade leverantörsfakturan saknar också underlag. Avdrag för ingående moms förutsätter godtagbart underlag.',
        suggestedAction: 'Begär underlag från kunden innan momsen redovisas, eller återför momsavdraget.',
        evidence: [
          { kind: 'voucher', ref: voucher.id, label: voucherReference(voucher) },
          { kind: 'voucher_row', ref: vatRow.id },
        ],
        // Same issue class as the missing-documentation anomaly rule on purpose:
        // both are "this posting has no receipt", and the consultant should see one item.
        issueClass: 'missing_documentation',
        signals: { documentCompleteness: 0, vatConsistency: 0.2, deterministicRuleMatch: 0 },
        gates: {
          validationsPassed: false,
          requiredDocumentationPresent: false,
          vatTreatmentUncertain: true,
        },
      }),
    );
  }
  return out;
}

/** 7. Accounts that require a cost center or project must have one. */
export function validateRequiredDimensions({ ctx, env }: ValidationInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const ccRequired = new Set(ctx.policy.costCenterRequiredAccounts);
  const projectRequired = new Set(ctx.policy.projectRequiredAccounts);

  for (const voucher of ctx.current.vouchers) {
    for (const row of voucher.rows) {
      const needsCc = ccRequired.has(row.account) && !row.costCenter;
      const needsProject = projectRequired.has(row.account) && !row.project;
      if (!needsCc && !needsProject) continue;

      const missing = [needsCc ? 'kostnadsställe' : null, needsProject ? 'projekt' : null]
        .filter(Boolean)
        .join(' och ');

      out.push(
        emitFinding(env, {
          rule: RULES.requiredDimension,
          type: 'validation.missing_required_dimension',
          severity: 'medium',
          subject: { voucherId: voucher.id, voucherRowId: row.id, accountNumber: row.account },
          amount: Math.abs(row.debit - row.credit),
          description: `Rad på konto ${row.account} i ${voucherReference(voucher)} saknar ${missing}.`,
          rationale: `Klientens policy kräver ${missing} på konto ${row.account}.`,
          suggestedAction: `Komplettera raden med ${missing}.`,
          evidence: [{ kind: 'voucher_row', ref: row.id }],
          issueClass: 'missing_dimension',
          signals: { dimensionConsistency: 0, deterministicRuleMatch: 0 },
          gates: { validationsPassed: false },
        }),
      );
    }
  }
  return out;
}

/** 8. The same source record must never be booked twice. */
export function validateDuplicateSourceRecords({ ctx, env }: ValidationInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const seen = new Map<string, Voucher>();

  for (const voucher of ctx.current.vouchers) {
    if (!voucher.supplierInvoiceNumber) continue;
    const key = `supplier_invoice:${voucher.supplierInvoiceNumber}`;
    const first = seen.get(key);

    if (!first && !ctx.alreadyProcessedSourceKeys.has(key)) {
      seen.set(key, voucher);
      continue;
    }

    out.push(
      emitFinding(env, {
        rule: RULES.duplicateSourceRecord,
        type: 'validation.duplicate_source_record',
        severity: 'critical',
        subject: {
          voucherId: voucher.id,
          supplierNumber: voucher.supplierNumber ?? undefined,
        },
        amount: voucherTotalDebit(voucher),
        description: `Underlaget ${voucher.supplierInvoiceNumber} är bokfört mer än en gång.`,
        rationale: first
          ? `Både ${voucherReference(first)} och ${voucherReference(voucher)} refererar till leverantörsfaktura ${voucher.supplierInvoiceNumber}.`
          : `Leverantörsfaktura ${voucher.supplierInvoiceNumber} har redan bokförts i en tidigare körning.`,
        suggestedAction: 'Makulera den ena bokföringen efter kontroll mot underlaget.',
        evidence: [
          { kind: 'voucher', ref: voucher.id },
          ...(first ? [{ kind: 'voucher' as const, ref: first.id }] : []),
          { kind: 'supplier_invoice' as const, ref: voucher.supplierInvoiceNumber },
        ],
        issueClass: 'duplicate_source_record',
        signals: { duplicateRisk: 0, deterministicRuleMatch: 0, reconciliationImpact: 0 },
        gates: { validationsPassed: false, conflictingRules: false },
      }),
    );
  }
  return out;
}

/**
 * 9. Workflow actions are idempotent.
 *
 * Returns the source keys this run would book, so the caller can persist them
 * and a re-run becomes a no-op instead of a double posting.
 */
export function collectSourceKeys(ctx: RuleContext): string[] {
  const keys = new Set<string>();
  for (const voucher of ctx.current.vouchers) {
    if (voucher.supplierInvoiceNumber) keys.add(`supplier_invoice:${voucher.supplierInvoiceNumber}`);
    if (voucher.customerInvoiceNumber) keys.add(`customer_invoice:${voucher.customerInvoiceNumber}`);
  }
  return [...keys].sort();
}

/** 10. An unimplemented step that carries accounting work blocks the period. */
export function notImplementedFinding(
  env: EmitEnvironment,
  step: { key: string; labelSv: string; description: string },
  extraEvidence: readonly EvidenceRef[] = [],
): FindingDraft {
  return emitFinding(env, {
    rule: RULES.stepNotImplemented,
    type: 'validation.step_not_implemented',
    severity: 'high',
    subject: {},
    amount: 0,
    description: `Processteget "${step.labelSv}" är inte implementerat.`,
    rationale: `${step.description} Steget bär verkligt bokföringsarbete, så perioden kan inte rapporteras som komplett förrän det hanterats manuellt eller implementerats.`,
    suggestedAction: 'Hantera steget manuellt i Fortnox och kvittera det, eller vänta på nästa fas.',
    evidence: extraEvidence,
    issueClass: `step_not_implemented:${step.key}`,
    signals: { deterministicRuleMatch: 0, reconciliationImpact: 0 },
    gates: {
      validationsPassed: false,
      requiresProfessionalJudgement: true,
      missingFortnoxCapability: false,
    },
  });
}

export const ALL_VALIDATIONS = [
  validateBalanced,
  validateAccounts,
  validateFinancialYear,
  validatePeriodNotLocked,
  validateVat,
  validateInputVatDocumentation,
  validateRequiredDimensions,
  validateDuplicateSourceRecords,
] as const;
