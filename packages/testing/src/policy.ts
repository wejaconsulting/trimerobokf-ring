import { sek } from '@trimeros/domain';

/**
 * The demo client's accounting policy.
 *
 * Chosen so the synthetic data lands on all three decision levels: the routine
 * bank fee clears every gate, the deviating amounts fall into review, and the
 * 45 000 kr manual voucher is above the materiality threshold and therefore
 * always manual.
 */
export const DEMO_POLICY = {
  materialityThreshold: sek(25000),
  automationAmountLimit: sek(10000),
  costCenterRequiredAccounts: [5010, 5410, 5460, 5910, 6110, 6212, 6540],
  projectRequiredAccounts: [] as number[],
  requireDocumentationForInputVat: true,
  historyWindowMonths: 12,
  amountDeviationThreshold: 0.5,
  vatRates: [0, 0.06, 0.12, 0.25],
} as const;
