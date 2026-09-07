import { FORTNOX_DATA_SOURCE_KIND, periodEnd, periodStart } from '@trimeros/domain';
import { DEMO_CLIENT, DEMO_POLICY, DEMO_PERIOD, buildSyntheticDataset, demoPeriods } from '@trimeros/testing';
import type { Database } from '../client.js';
import * as s from '../schema/index.js';
import { DEMO_IDS } from './ids.js';

/**
 * Seeds the demo tenant.
 *
 * Only *configuration* is seeded: firm, users, client, policy, client rules,
 * the integration connection and the accounting periods. The accounting data
 * itself is not written here - it is imported by the close run through the
 * Fortnox mock adapter, so the demo exercises the real import path rather than
 * a shortcut.
 *
 * Idempotent: running it twice leaves the database in the same state.
 */
export async function seedDemoData(db: Database): Promise<{ tenantId: string; clientId: string }> {
  const tenantId = DEMO_IDS.tenant;
  const dataset = buildSyntheticDataset();

  await db
    .insert(s.firms)
    .values({ id: DEMO_IDS.firm, name: 'Trimeros Redovisning AB', organisationNumber: '556999-1234' })
    .onConflictDoNothing();

  await db
    .insert(s.users)
    .values([
      {
        id: DEMO_IDS.users.consultant,
        tenantId,
        email: 'anna.lindqvist@trimeros.example',
        displayName: 'Anna Lindqvist',
        role: 'consultant',
        active: true,
      },
      {
        id: DEMO_IDS.users.reviewer,
        tenantId,
        email: 'johan.berg@trimeros.example',
        displayName: 'Johan Berg',
        role: 'reviewer',
        active: true,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(s.clients)
    .values({
      id: DEMO_IDS.client,
      tenantId,
      name: DEMO_CLIENT.name,
      organisationNumber: DEMO_CLIENT.organisationNumber,
      fortnoxCompanyRef: DEMO_CLIENT.fortnoxCompanyRef,
      active: true,
    })
    .onConflictDoNothing();

  await db
    .insert(s.clientAccountingPolicies)
    .values({
      id: DEMO_IDS.policy,
      tenantId,
      clientId: DEMO_IDS.client,
      materialityThreshold: DEMO_POLICY.materialityThreshold,
      automationAmountLimit: DEMO_POLICY.automationAmountLimit,
      costCenterRequiredAccounts: [...DEMO_POLICY.costCenterRequiredAccounts],
      projectRequiredAccounts: [...DEMO_POLICY.projectRequiredAccounts],
      requireDocumentationForInputVat: DEMO_POLICY.requireDocumentationForInputVat,
      historyWindowMonths: DEMO_POLICY.historyWindowMonths,
      amountDeviationThreshold: DEMO_POLICY.amountDeviationThreshold,
      vatRates: [...DEMO_POLICY.vatRates],
    })
    .onConflictDoNothing();

  await db
    .insert(s.clientRules)
    .values([
      {
        id: DEMO_IDS.rules.dimension5410,
        tenantId,
        clientId: DEMO_IDS.client,
        kind: 'dimension_requirement',
        version: 'client-rule@1.0.0',
        active: true,
        config: { account: 5410, costCenter: 'KONS' },
      },
      {
        id: DEMO_IDS.rules.recurringRent,
        tenantId,
        clientId: DEMO_IDS.client,
        kind: 'recurring_cost',
        version: 'client-rule@1.0.0',
        active: true,
        config: { supplierNumber: 'L001', account: 5010, accrualAccount: 2990 },
      },
      {
        id: DEMO_IDS.rules.vat6540,
        tenantId,
        clientId: DEMO_IDS.client,
        kind: 'vat_code_for_account',
        version: 'client-rule@1.0.0',
        active: true,
        config: { account: 6540, vatCode: 'MP1' },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(s.integrationConnections)
    .values({
      id: DEMO_IDS.connection,
      tenantId,
      clientId: DEMO_IDS.client,
      kind: FORTNOX_DATA_SOURCE_KIND,
      mode: 'mock',
      // Mirrors the scopes a real integration would request for this workflow.
      scopes: ['bookkeeping', 'costcenter', 'project', 'supplierinvoice', 'invoice', 'archive'],
      // No credential exists for the mock adapter, and none is ever stored here.
      credentialRef: null,
      writesEnabled: false,
      healthy: true,
      lastCheckedAt: new Date(),
    })
    .onConflictDoNothing();

  const periods = demoPeriods();
  await db
    .insert(s.accountingPeriods)
    .values(
      periods.map((periodKey) => ({
        id: `period-${DEMO_IDS.client}-${periodKey}`,
        tenantId,
        clientId: DEMO_IDS.client,
        periodKey,
        startDate: periodStart(periodKey),
        endDate: periodEnd(periodKey),
        // Everything before the demo period is closed; the demo period is open.
        status: periodKey === DEMO_PERIOD ? 'open' : 'locked',
        fortnoxLockedThrough: dataset.lockedThrough,
      })),
    )
    .onConflictDoNothing();

  return { tenantId, clientId: DEMO_IDS.client };
}
