import { z } from 'zod';

/** A period key is always `YYYY-MM` - phase 1 closes monthly periods. */
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'periodKey must be YYYY-MM');
export type PeriodKey = z.infer<typeof periodKeySchema>;

/** An ISO calendar date, `YYYY-MM-DD`, without a time component. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export type IsoDate = z.infer<typeof isoDateSchema>;

export function periodKeyOf(date: IsoDate): PeriodKey {
  return date.slice(0, 7);
}

export function periodStart(key: PeriodKey): IsoDate {
  return `${key}-01`;
}

export function periodEnd(key: PeriodKey): IsoDate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this month.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function isInPeriod(date: IsoDate, key: PeriodKey): boolean {
  return periodKeyOf(date) === key;
}

/** Returns the `count` period keys immediately preceding `key`, oldest first. */
export function previousPeriods(key: PeriodKey, count: number): PeriodKey[] {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const out: PeriodKey[] = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function addMonths(key: PeriodKey, months: number): PeriodKey {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function comparePeriods(a: PeriodKey, b: PeriodKey): number {
  return a.localeCompare(b);
}
