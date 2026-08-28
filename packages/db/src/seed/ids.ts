/**
 * Deterministic identifiers for the demo tenant.
 *
 * Fixed rather than random so re-seeding is idempotent and so documentation,
 * tests and the smoke test can all refer to the same rows.
 */
export const DEMO_IDS = {
  firm: 'firm-trimeros',
  tenant: 'firm-trimeros',
  client: 'client-nordvik',
  policy: 'policy-nordvik',
  connection: 'conn-nordvik-fortnox',
  users: {
    consultant: 'user-anna-consultant',
    reviewer: 'user-johan-reviewer',
  },
  rules: {
    dimension5410: 'rule-dim-5410',
    recurringRent: 'rule-recurring-l001',
    vat6540: 'rule-vat-6540',
  },
} as const;
