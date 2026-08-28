/**
 * All monetary amounts in this system are integers in *öre* (1/100 SEK).
 *
 * Floating point kronor are never used for arithmetic or comparison: rounding
 * drift is unacceptable in a system whose whole purpose is to assert that
 * debit equals credit.
 */
export type Ore = number;

export const ORE_PER_SEK = 100;

export function sek(amount: number): Ore {
  return Math.round(amount * ORE_PER_SEK);
}

export function toSek(amount: Ore): number {
  return amount / ORE_PER_SEK;
}

export function formatSek(amount: Ore): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
  }).format(toSek(amount));
}

export function absOre(amount: Ore): Ore {
  return Math.abs(amount);
}

/** Relative deviation of `actual` from `baseline`, guarding against a zero baseline. */
export function relativeDeviation(actual: Ore, baseline: Ore): number {
  if (baseline === 0) return actual === 0 ? 0 : 1;
  return Math.abs(actual - baseline) / Math.abs(baseline);
}

export function sum(values: readonly Ore[]): Ore {
  return values.reduce<Ore>((acc, v) => acc + v, 0);
}
