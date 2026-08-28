import { periodKeyOf, previousPeriods } from '@trimeros/domain';
import type { LedgerSnapshot, Voucher } from '@trimeros/domain';
import type { StepContext } from '../run-context.js';
import type { StepOutcome } from '../types.js';

/**
 * Step 1 - Agent readiness.
 *
 * Verifies that the integration can actually serve what the rest of the run
 * needs, and loads the period plus its history window. The import lives here
 * because readiness cannot be asserted without looking at the real account
 * plan, financial years and voucher series anyway - checking them and then
 * discarding them would just mean fetching twice.
 *
 * A failure here is blocking by design: running anomaly rules against a chart
 * of accounts you could not verify produces confident nonsense.
 */
export async function stepAgentReadiness(ctx: StepContext): Promise<StepOutcome> {
  const capabilities = await ctx.fortnox.capabilities();
  ctx.state.capabilities = capabilities;

  const connection = await ctx.repos.getIntegrationConnection({
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
  });
  if (!connection) {
    return { status: 'blocked', reasonCode: 'no_integration_connection', message: 'Ingen Fortnox-anslutning är konfigurerad för klienten.' };
  }
  if (connection.writesEnabled) {
    // Defence in depth: a run must never proceed against a write-enabled
    // connection while the system is in shadow mode.
    return {
      status: 'blocked',
      reasonCode: 'writes_enabled_in_shadow_mode',
      message: 'Anslutningen har skrivning aktiverad, vilket inte är tillåtet i shadow mode.',
    };
  }

  const financialYears = await ctx.fortnox.listFinancialYears();
  const periodStartDate = `${ctx.periodKey}-01`;
  const financialYear = financialYears.find(
    (y) => y.fromDate <= periodStartDate && periodStartDate <= y.toDate,
  );
  if (!financialYear) {
    return {
      status: 'blocked',
      reasonCode: 'no_financial_year',
      message: `Inget räkenskapsår täcker ${ctx.periodKey}.`,
    };
  }

  const [accounts, voucherSeries, suppliers, customers, costCenters, projects, locked] =
    await Promise.all([
      ctx.fortnox.listAccounts(financialYear.id),
      ctx.fortnox.listVoucherSeries(),
      ctx.fortnox.listSuppliers(),
      ctx.fortnox.listCustomers(),
      ctx.fortnox.listCostCenters(),
      ctx.fortnox.listProjects(),
      ctx.fortnox.getLockedPeriod(),
    ]);

  if (accounts.length === 0) {
    return { status: 'blocked', reasonCode: 'empty_account_plan', message: 'Kontoplanen är tom.' };
  }
  if (voucherSeries.length === 0) {
    return { status: 'blocked', reasonCode: 'no_voucher_series', message: 'Inga verifikationsserier hittades.' };
  }

  // --- import the period and its history window --------------------------
  const historyKeys = previousPeriods(ctx.periodKey, ctx.policy.historyWindowMonths);
  const historyVouchers: Voucher[] = [];
  for (const key of historyKeys) {
    historyVouchers.push(...(await ctx.fortnox.listVouchers(key)));
  }

  const [vouchers, supplierInvoices, customerInvoices, payments, bankTransactions] = await Promise.all([
    ctx.fortnox.listVouchers(ctx.periodKey),
    ctx.fortnox.listSupplierInvoices(ctx.periodKey),
    ctx.fortnox.listCustomerInvoices(ctx.periodKey),
    ctx.fortnox.listPayments(ctx.periodKey),
    ctx.fortnox.listBankTransactions(ctx.periodKey).catch(() => []),
  ]);

  // Supplier invoices from earlier periods matter: an invoice booked into the
  // wrong month is only visible if both ends are in scope.
  const historySupplierInvoices = (
    await Promise.all(historyKeys.map((k) => ctx.fortnox.listSupplierInvoices(k)))
  ).flat();

  const current: LedgerSnapshot = {
    accounts,
    vouchers,
    suppliers,
    customers,
    supplierInvoices,
    customerInvoices,
    payments,
    bankTransactions,
    costCenters,
    projects,
    financialYears,
    voucherSeries,
  };

  ctx.state.ledger = {
    current,
    historyVouchers,
    allSupplierInvoices: [...historySupplierInvoices, ...supplierInvoices],
    lockedThrough: locked.lockedThrough,
  };

  // --- persist the normalised copies -------------------------------------
  const scope = { tenantId: ctx.tenantId, clientId: ctx.clientId };

  await ctx.repos.upsertImportedRecords([
    ...accounts.map((a) => ({
      id: `ir-${ctx.clientId}-account-${a.number}`,
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      kind: 'account',
      externalId: String(a.number),
      periodKey: null,
      payload: a,
      contentHash: hash(a),
    })),
    ...vouchers.map((v) => ({
      id: `ir-${ctx.clientId}-voucher-${v.id}`,
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      kind: 'voucher',
      externalId: v.id,
      periodKey: periodKeyOf(v.transactionDate),
      payload: v,
      contentHash: hash(v),
    })),
    ...supplierInvoices.map((i) => ({
      id: `ir-${ctx.clientId}-si-${i.id}`,
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      kind: 'supplier_invoice',
      externalId: i.id,
      periodKey: periodKeyOf(i.invoiceDate),
      payload: i,
      contentHash: hash(i),
    })),
    ...customerInvoices.map((i) => ({
      id: `ir-${ctx.clientId}-ci-${i.id}`,
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      kind: 'customer_invoice',
      externalId: i.id,
      periodKey: periodKeyOf(i.invoiceDate),
      payload: i,
      contentHash: hash(i),
    })),
  ]);

  await ctx.repos.replaceTransactions(
    scope,
    ctx.periodKey,
    vouchers.flatMap((v) =>
      v.rows.map((r) => ({
        id: `tx-${r.id}`,
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        periodKey: ctx.periodKey,
        transactionDate: v.transactionDate,
        account: r.account,
        debit: r.debit,
        credit: r.credit,
        description: r.description,
        costCenter: r.costCenter,
        project: r.project,
        vatCode: r.vatCode,
        voucherId: v.id,
        voucherRowId: r.id,
        supplierNumber: v.supplierNumber,
        customerNumber: v.customerNumber,
      })),
    ),
  );

  await ctx.audit({
    operation: 'import.records_ingested',
    actor: { kind: 'system', id: 'workflow-engine' },
    result: 'ok',
    inputRefs: [`period:${ctx.periodKey}`, `adapter:${ctx.fortnox.adapterName}`],
  });

  const unavailable = capabilities.unavailable.length;
  return {
    status: 'completed',
    message:
      `Anslutning ${connection.mode}, räkenskapsår ${financialYear.fromDate}–${financialYear.toDate}, ` +
      `${accounts.length} konton, ${vouchers.length} verifikationer i perioden, ` +
      `${historyVouchers.length} i historiken (${ctx.policy.historyWindowMonths} mån). ` +
      `${unavailable} capability/capabilities saknas i publikt API.`,
  };
}

/** Stable content hash for change detection on imported records. */
function hash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
