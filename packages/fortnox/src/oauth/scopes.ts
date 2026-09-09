/**
 * Fortnox OAuth scopes.
 *
 * Only scopes needed for reading are listed. There is no write scope here and
 * that is the point: the consent screen Marcus sees is the first place the
 * read-only posture becomes visible, and a scope that was never granted cannot
 * be used later by a configuration mistake.
 *
 * Scope names are taken from Fortnox's authorization documentation. Names
 * marked unverified below were not corroborated against the official docs from
 * this environment (Fortnox hosts are blocked by the network policy - see
 * docs/fortnox-capability-matrix.md) and are therefore NOT requested.
 */

/** Requested for every connection. Each one is read-only in our usage. */
export const FORTNOX_READ_SCOPES = [
  'companyinformation',
  'bookkeeping',
  'invoice',
  'supplierinvoice',
  'customer',
  'supplier',
  'payment',
  'costcenter',
] as const;

export type FortnoxReadScope = (typeof FORTNOX_READ_SCOPES)[number];

/**
 * Scopes deliberately never requested.
 *
 * `archive` and `settings` appear in third-party write-ups but were not
 * confirmed against Fortnox's own documentation, and nothing in this phase
 * needs them. Anything that would permit writing is absent by design.
 */
export const FORTNOX_SCOPES_NOT_REQUESTED: Readonly<Record<string, string>> = {
  archive: 'Not needed in this phase; scope name not verified against official docs.',
  settings: 'Not needed in this phase; scope name not verified against official docs.',
  salary: 'Payroll is out of scope for the bookkeeping workflow.',
} as const;

/** Fortnox expects a space-separated scope list on the authorize URL. */
export function scopeParam(scopes: readonly string[] = FORTNOX_READ_SCOPES): string {
  return scopes.join(' ');
}
