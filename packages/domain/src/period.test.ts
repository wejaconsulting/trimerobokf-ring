import { describe, expect, it } from 'vitest';
import { formatSek, relativeDeviation, sek, sum, toSek } from './money.js';
import { addMonths, isInPeriod, periodEnd, periodKeyOf, periodStart, previousPeriods } from './period.js';

describe('period helpers', () => {
  it('derives period keys and boundaries', () => {
    expect(periodKeyOf('2025-08-14')).toBe('2025-08');
    expect(periodStart('2025-08')).toBe('2025-08-01');
    expect(periodEnd('2025-08')).toBe('2025-08-31');
    expect(periodEnd('2025-02')).toBe('2025-02-28');
    expect(periodEnd('2024-02')).toBe('2024-02-29');
  });

  it('walks months across year boundaries', () => {
    expect(addMonths('2025-01', -1)).toBe('2024-12');
    expect(addMonths('2024-12', 2)).toBe('2025-02');
    expect(previousPeriods('2025-02', 3)).toEqual(['2024-11', '2024-12', '2025-01']);
  });

  it('returns exactly the requested number of history periods', () => {
    expect(previousPeriods('2025-08', 12)).toHaveLength(12);
    expect(previousPeriods('2025-08', 12).at(-1)).toBe('2025-07');
  });

  it('checks period membership', () => {
    expect(isInPeriod('2025-08-01', '2025-08')).toBe(true);
    expect(isInPeriod('2025-09-01', '2025-08')).toBe(false);
  });
});

describe('money', () => {
  it('converts kronor to integer öre without drift', () => {
    expect(sek(0.1) + sek(0.2)).toBe(sek(0.3));
    expect(toSek(sek(1234.56))).toBe(1234.56);
  });

  it('sums exactly', () => {
    expect(sum([sek(0.1), sek(0.2), sek(0.3)])).toBe(sek(0.6));
  });

  it('formats Swedish currency', () => {
    // Intl uses a non-breaking space as the Swedish thousands separator.
    expect(formatSek(sek(25000)).replace(/\s/g, ' ')).toContain('25 000,00');
  });

  it('computes relative deviation with a zero-safe baseline', () => {
    expect(relativeDeviation(sek(200), sek(100))).toBe(1);
    expect(relativeDeviation(0, 0)).toBe(0);
    expect(relativeDeviation(sek(5), 0)).toBe(1);
  });
});
