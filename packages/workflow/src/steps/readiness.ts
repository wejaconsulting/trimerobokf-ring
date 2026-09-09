import {
  FORTNOX_CONNECTION_KIND,
  FORTNOX_DATA_SOURCE_KIND,
  periodEnd,
  periodKeyOf,
  previousPeriods,
  voucherSchema,
} from '@trimeros/domain';
import type { LedgerSnapshot, Voucher } from '@trimeros/domain';
import { FortnoxApiError, FortnoxConnectionError } from '@trimeros/fortnox';
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
  const { dataSource } = ctx;
  if (dataSource.kind === 'none') {
    return {
      status: 'blocked',
      reasonCode: 'no_integration_connection',
      message: dataSource.reason ?? 'Ingen Fortnox-anslutning är konfigurerad för klienten.',
    };
  }

  // The connection row that backs the resolved source is named explicitly: a
  // client may hold both a demo-data row and a live OAuth grant, and the run
  // must check the one it is actually reading from.
  const connection = await ctx.repos.getIntegrationConnection(
    { tenantId: ctx.tenantId, clientId: ctx.clientId },
    dataSource.kind === 'real' ? FORTNOX_CONNECTION_KIND : FORTNOX_DATA_SOURCE_KIND,
  );
  if (!connection) {
    return {
      status: 'blocked',
      reasonCode: 'no_integration_connection',
      message: 'Ingen Fortnox-anslutning är konfigurerad för klienten.',
    };
  }
  if (dataSource.kind === 'real' && connection.status !== 'connected') {
    return {
      status: 'blocked',
      reasonCode: 'fortnox_reconnect_required',
      message: 'Fortnox-anslutningen behöver återanslutas innan en avstämning kan köras.',
    };
  }
  if (connection.writesEnabled && ctx.shadowMode) {
    // Defence in depth: a run must never proceed against a write-enabled
    // connection while the system is in shadow mode.
    return {
      status: 'blocked',
      reasonCode: 'writes_enabled_in_shadow_mode',
      message: 'Anslutningen har skrivning aktiverad, vilket inte är tillåtet i shadow mode.',
    };
  }

  try {
    return await importPeriod(ctx, connection.mode);
  } catch (error) {
    // A live account that answers badly is a blocked run with a plain reason,
    // not a stack trace. Nothing below carries a credential.
    if (error instanceof FortnoxConnectionError) {
      return {
        status: 'blocked',
        reasonCode: `fortnox_${error.code}`,
        message: `Fortnox-anslutningen kunde inte användas (${error.code}). Återanslut klienten under Inställningar → Fortnox.`,
      };
    }
    if (error instanceof FortnoxApiError) {
      return {
        status: 'blocked',
        reasonCode: error.requiresReconnect ? 'fortnox_reconnect_required' : 'fortnox_read_failed',
        message: error.requiresReconnect
          ? 'Fortnox avvisade åtkomsttoken (401). Återanslut klienten under Inställningar → Fortnox.'
          : `Fortnox svarade ${error.status} på ${error.path}${error.fortnoxMessage ? `: ${error.fortnoxMessage}` : ''}.`,
      };
    }
    throw error;
  }
}

async function importPeriod(ctx: StepContext, connectionMode: string): Promise<StepOutcome> {
  const capabilities = await ctx.fortnox.capabilities();
  ctx.state.capabilities = capabilities;

  const financialYears = await ctx.fortnox.listFinancialYears();
  const periodStartDate = `${ctx.periodKey}-01`;
  const financialYear = financialYears.find(
    (y) => y.fromDate <= periodStartDate && periodStartDate <= y.toDate,
  );
  if (!financialYear) {
    return {
      status: 'blocked',
      reasonCode: 'no_financial_year',
      message: `Inget räkenskapsår täcker ${ctx.periodKey}. Skapa räkenskapsåret i Fortnox och kör om.`,
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
  const scope = { tenantId: ctx.tenantId, clientId: ctx.clientId };
  const historyKeys = previousPeriods(ctx.periodKey, ctx.policy.historyWindowMonths);
  const historyVouchers: Voucher[] = [];
  let historyFromCache = 0;
  for (const key of historyKeys) {
    // A period Fortnox reports as locked cannot change, so its vouchers are
    // read from the copies an earlier run stored. Against a real account this
    // is the difference between a run that takes seconds and one that
    // re-fetches a year of vouchers one by one. Demo data is never cached, so
    // a client moved from demo data to a live account starts clean.
    const cacheable =
      ctx.dataSource.kind === 'real' &&
      locked.lockedThrough !== null &&
      periodEnd(key) <= locked.lockedThrough;
    const cached = cacheable ? await cachedVouchers(ctx, key) : null;
    if (cached && cached.length > 0) {
      historyVouchers.push(...cached);
      historyFromCache += cached.length;
      continue;
    }
    const fetched = await ctx.fortnox.listVouchers(key);
    historyVouchers.push(...fetched);
    if (cacheable && fetched.length > 0) {
      await ctx.repos.upsertImportedRecords(fetched.map((v) => voucherRecord(ctx, v)));
    }
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
    ...vouchers.map((v) => voucherRecord(ctx, v)),
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
    inputRefs: [
      `period:${ctx.periodKey}`,
      `adapter:${ctx.fortnox.adapterName}`,
      `source:${ctx.dataSource.kind}`,
      `vouchers:${vouchers.length}`,
      `history_vouchers:${historyVouchers.length}`,
      `history_from_cache:${historyFromCache}`,
    ],
  });

  const unavailable = capabilities.unavailable.length;
  const sourceLabel = ctx.dataSource.kind === 'real' ? `Fortnox (${ctx.dataSource.label})` : ctx.dataSource.label;
  return {
    status: 'completed',
    message:
      `Datakälla ${sourceLabel}, anslutning ${connectionMode}, räkenskapsår ${financialYear.fromDate}–${financialYear.toDate}, ` +
      `${accounts.length} konton, ${vouchers.length} verifikationer i perioden, ` +
      `${historyVouchers.length} i historiken (${ctx.policy.historyWindowMonths} mån` +
      `${historyFromCache > 0 ? `, ${historyFromCache} från cache` : ''}). ` +
      `${unavailable} capability/capabilities saknas i publikt API.`,
  };
}

/** Vouchers a previous run stored for a period, or null if there are none. */
async function cachedVouchers(ctx: StepContext, periodKey: string): Promise<Voucher[] | null> {
  const payloads = await ctx.repos.listImportedRecordPayloads(
    { tenantId: ctx.tenantId, clientId: ctx.clientId },
    'voucher',
    periodKey,
  );
  if (payloads.length === 0) return null;
  const vouchers: Voucher[] = [];
  for (const payload of payloads) {
    const parsed = voucherSchema.safeParse(payload);
    // One unreadable copy invalidates the cache for the period: fetch fresh.
    if (!parsed.success) return null;
    vouchers.push(parsed.data);
  }
  return vouchers;
}

function voucherRecord(ctx: StepContext, v: Voucher) {
  return {
    id: `ir-${ctx.clientId}-voucher-${v.id}`,
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    closeRunId: ctx.closeRunId,
    kind: 'voucher',
    externalId: v.id,
    periodKey: periodKeyOf(v.transactionDate),
    payload: v,
    contentHash: hash(v),
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
