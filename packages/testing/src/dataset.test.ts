import { periodKeyOf, voucherTotalCredit, voucherTotalDebit } from '@trimeros/domain';
import { describe, expect, it } from 'vitest';
import { buildAccounts } from './accounts.js';
import { DEMO_HISTORY_MONTHS, DEMO_PERIOD, buildSyntheticDataset, demoPeriods } from './dataset.js';

const dataset = buildSyntheticDataset();
const current = dataset.vouchers.filter((v) => periodKeyOf(v.transactionDate) === DEMO_PERIOD);

describe('synthetic dataset', () => {
  it('covers at least 12 months of history plus the demo period', () => {
    expect(demoPeriods()).toHaveLength(DEMO_HISTORY_MONTHS + 1);
    const historyPeriods = new Set(
      dataset.vouchers.map((v) => periodKeyOf(v.transactionDate)).filter((p) => p < DEMO_PERIOD),
    );
    expect(historyPeriods.size).toBeGreaterThanOrEqual(12);
  });

  it('is deterministic across builds', () => {
    expect(JSON.stringify(buildSyntheticDataset())).toBe(JSON.stringify(dataset));
  });

  it('produces only balanced vouchers - Fortnox would never accept otherwise', () => {
    for (const voucher of dataset.vouchers) {
      expect(voucherTotalDebit(voucher)).toBe(voucherTotalCredit(voucher));
    }
  });

  it('only uses accounts that exist in the chart', () => {
    const known = new Set(buildAccounts().map((a) => a.number));
    for (const voucher of dataset.vouchers) {
      for (const row of voucher.rows) expect(known.has(row.account)).toBe(true);
    }
  });

  it('includes recurring rent, SaaS, bank fees and cleaning across the history', () => {
    const history = dataset.vouchers.filter((v) => periodKeyOf(v.transactionDate) < DEMO_PERIOD);
    for (const supplier of ['L001', 'L002', 'L003', 'L007']) {
      const months = new Set(
        history.filter((v) => v.supplierNumber === supplier).map((v) => periodKeyOf(v.transactionDate)),
      );
      expect(months.size).toBeGreaterThanOrEqual(12);
    }
  });

  it('includes customer invoices, payments, VAT, cost centers and projects', () => {
    expect(dataset.customerInvoices.length).toBeGreaterThan(20);
    expect(dataset.payments.length).toBeGreaterThan(20);
    expect(dataset.vouchers.some((v) => v.rows.some((r) => r.account === 2611))).toBe(true);
    expect(dataset.vouchers.some((v) => v.rows.some((r) => r.costCenter === 'ADM'))).toBe(true);
    expect(dataset.vouchers.some((v) => v.rows.some((r) => r.project === 'P100'))).toBe(true);
  });

  it('seeds the intended exceptions into the demo period', () => {
    // Missing receipt.
    expect(current.some((v) => !v.hasFileConnection && v.supplierNumber === 'L005')).toBe(true);
    // Duplicate: one invoice number, two vouchers.
    const saas = current.filter((v) => v.supplierInvoiceNumber === `L002-${DEMO_PERIOD.replace('-', '')}`);
    expect(saas).toHaveLength(2);
    // New supplier with no history.
    expect(current.some((v) => v.supplierNumber === 'L006')).toBe(true);
    // Recurring rent absent.
    expect(current.some((v) => v.supplierNumber === 'L001')).toBe(false);
    // Wrong VAT code.
    expect(current.some((v) => v.rows.some((r) => r.vatCode === 'MP2'))).toBe(true);
    // Manual A voucher for a material amount.
    expect(current.some((v) => v.manual && v.rows.some((r) => r.account === 6992))).toBe(true);
    // Posting to a balance account for a supplier that always used a result account.
    expect(current.some((v) => v.supplierNumber === 'L007' && v.rows.some((r) => r.account === 1790))).toBe(true);
    // Accrual row missing its cost center.
    expect(current.some((v) => v.rows.some((r) => r.account === 5410 && r.costCenter === null))).toBe(true);
  });

  it('locks the prior period and leaves the demo period open', () => {
    expect(dataset.lockedThrough).toBe('2025-07-31');
  });

  it('leaves most of the demo period clean, so the demo is not all red', () => {
    const flagged = new Set(['L005', 'L006', 'L007', 'L008']);
    const clean = current.filter((v) => !v.supplierNumber || !flagged.has(v.supplierNumber));
    expect(clean.length).toBeGreaterThan(3);
  });
});
