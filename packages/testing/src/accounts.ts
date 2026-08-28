import { type Account, accountTypeFromNumber } from '@trimeros/domain';

interface AccountSeed {
  readonly number: number;
  readonly description: string;
  readonly vatCode: string | null;
  readonly active?: boolean;
  readonly costCenterRequired?: boolean;
  readonly projectRequired?: boolean;
}

/**
 * A realistic subset of the Swedish BAS chart of accounts.
 *
 * Entirely synthetic: these are standard BAS account numbers and Swedish
 * account names, not data from any real company.
 */
const SEEDS: readonly AccountSeed[] = [
  { number: 1220, description: 'Inventarier och verktyg', vatCode: null },
  { number: 1229, description: 'Ackumulerade avskrivningar på inventarier', vatCode: null },
  { number: 1510, description: 'Kundfordringar', vatCode: null },
  { number: 1650, description: 'Momsfordran', vatCode: null },
  { number: 1790, description: 'Övriga förutbetalda kostnader och upplupna intäkter', vatCode: null },
  { number: 1930, description: 'Företagskonto / checkkonto', vatCode: null },
  { number: 2440, description: 'Leverantörsskulder', vatCode: null },
  { number: 2611, description: 'Utgående moms på försäljning inom Sverige, 25 %', vatCode: 'U25' },
  { number: 2641, description: 'Debiterad ingående moms', vatCode: 'I25' },
  { number: 2650, description: 'Redovisningskonto för moms', vatCode: null },
  { number: 2890, description: 'Övriga kortfristiga skulder', vatCode: null },
  { number: 2990, description: 'Upplupna kostnader och förutbetalda intäkter', vatCode: null },
  { number: 2999, description: 'OBS-konto (spärrat)', vatCode: null, active: false },
  { number: 3011, description: 'Försäljning tjänster inom Sverige, 25 % moms', vatCode: 'MP1' },
  { number: 5010, description: 'Lokalhyra', vatCode: 'MP1', costCenterRequired: true },
  { number: 5410, description: 'Förbrukningsinventarier', vatCode: 'MP1', costCenterRequired: true },
  { number: 5460, description: 'Förbrukningsmaterial', vatCode: 'MP1', costCenterRequired: true },
  { number: 5910, description: 'Annonsering', vatCode: 'MP1', costCenterRequired: true },
  { number: 6110, description: 'Kontorsmateriel', vatCode: 'MP1', costCenterRequired: true },
  { number: 6212, description: 'Mobiltelefon', vatCode: 'MP1', costCenterRequired: true },
  { number: 6540, description: 'IT-tjänster', vatCode: 'MP1', costCenterRequired: true },
  { number: 6570, description: 'Bankkostnader', vatCode: null },
  { number: 6992, description: 'Övriga externa kostnader, ej avdragsgilla', vatCode: null },
  { number: 7830, description: 'Avskrivningar på inventarier och verktyg', vatCode: null },
];

export function buildAccounts(): Account[] {
  return SEEDS.map((s) => ({
    number: s.number,
    description: s.description,
    type: accountTypeFromNumber(s.number),
    active: s.active ?? true,
    vatCode: s.vatCode,
    costCenterRequired: s.costCenterRequired ?? false,
    projectRequired: s.projectRequired ?? false,
  }));
}
