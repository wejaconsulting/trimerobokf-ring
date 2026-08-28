import {
  type Ore,
  type PeriodKey,
  type Voucher,
  type VoucherRow,
  isResultAccount,
  periodKeyOf,
} from '@trimeros/domain';

/**
 * Derived history profiles.
 *
 * Everything the anomaly rules compare against is computed here, once, from
 * the raw voucher history. Rules stay pure functions over this index, which is
 * what keeps every finding explainable: the "why" can always be traced back to
 * a concrete count or median in this structure.
 */

export interface SupplierProfile {
  readonly supplierNumber: string;
  /** How many times each cost account was used for this supplier. */
  readonly accountCounts: ReadonlyMap<number, number>;
  /** How many times each VAT code appeared on this supplier's cost rows. */
  readonly vatCodeCounts: ReadonlyMap<string, number>;
  /** Net cost amounts (excl. VAT) per period, used for amount comparison. */
  readonly netAmounts: readonly Ore[];
  readonly medianNet: Ore;
  readonly periodsSeen: ReadonlySet<PeriodKey>;
  readonly totalPostings: number;
  /** True when every historical posting hit a result (3000+) account. */
  readonly alwaysResultAccount: boolean;
}

export interface HistoryIndex {
  readonly suppliers: ReadonlyMap<string, SupplierProfile>;
  readonly accountUsage: ReadonlyMap<number, number>;
  readonly periods: readonly PeriodKey[];
  /** Account -> the VAT code most often seen on its rows. */
  readonly dominantVatCodeByAccount: ReadonlyMap<number, string>;
}

/** Cost rows are the interesting ones: skip VAT and balance-sheet clearing rows. */
function isCostRow(row: VoucherRow): boolean {
  return row.account !== 2440 && row.account !== 2641 && row.account !== 1510 && row.account !== 2611;
}

export function buildHistoryIndex(vouchers: readonly Voucher[]): HistoryIndex {
  const suppliers = new Map<
    string,
    {
      accountCounts: Map<number, number>;
      vatCodeCounts: Map<string, number>;
      netAmounts: Ore[];
      periodsSeen: Set<PeriodKey>;
      totalPostings: number;
      allResult: boolean;
    }
  >();
  const accountUsage = new Map<number, number>();
  const vatByAccount = new Map<number, Map<string, number>>();
  const periods = new Set<PeriodKey>();

  for (const voucher of vouchers) {
    periods.add(periodKeyOf(voucher.transactionDate));

    for (const row of voucher.rows) {
      accountUsage.set(row.account, (accountUsage.get(row.account) ?? 0) + 1);
      if (row.vatCode) {
        const perAccount = vatByAccount.get(row.account) ?? new Map<string, number>();
        perAccount.set(row.vatCode, (perAccount.get(row.vatCode) ?? 0) + 1);
        vatByAccount.set(row.account, perAccount);
      }
    }

    const supplierNumber = voucher.supplierNumber;
    if (!supplierNumber) continue;

    const entry =
      suppliers.get(supplierNumber) ??
      {
        accountCounts: new Map<number, number>(),
        vatCodeCounts: new Map<string, number>(),
        netAmounts: [] as Ore[],
        periodsSeen: new Set<PeriodKey>(),
        totalPostings: 0,
        allResult: true,
      };

    let netForVoucher = 0;
    for (const row of voucher.rows) {
      if (!isCostRow(row)) continue;
      const net = row.debit - row.credit;
      if (net === 0) continue;
      entry.accountCounts.set(row.account, (entry.accountCounts.get(row.account) ?? 0) + 1);
      if (row.vatCode) {
        entry.vatCodeCounts.set(row.vatCode, (entry.vatCodeCounts.get(row.vatCode) ?? 0) + 1);
      }
      if (!isResultAccount(row.account)) entry.allResult = false;
      netForVoucher += net;
      entry.totalPostings += 1;
    }

    if (netForVoucher !== 0) entry.netAmounts.push(netForVoucher);
    entry.periodsSeen.add(periodKeyOf(voucher.transactionDate));
    suppliers.set(supplierNumber, entry);
  }

  const supplierProfiles = new Map<string, SupplierProfile>();
  for (const [supplierNumber, e] of suppliers) {
    supplierProfiles.set(supplierNumber, {
      supplierNumber,
      accountCounts: e.accountCounts,
      vatCodeCounts: e.vatCodeCounts,
      netAmounts: e.netAmounts,
      medianNet: median(e.netAmounts),
      periodsSeen: e.periodsSeen,
      totalPostings: e.totalPostings,
      alwaysResultAccount: e.allResult && e.totalPostings > 0,
    });
  }

  const dominantVatCodeByAccount = new Map<number, string>();
  for (const [account, counts] of vatByAccount) {
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) dominantVatCodeByAccount.set(account, best[0]);
  }

  return {
    suppliers: supplierProfiles,
    accountUsage,
    periods: [...periods].sort(),
    dominantVatCodeByAccount,
  };
}

export function median(values: readonly Ore[]): Ore {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * A recurring cost is a supplier+account pair seen in at least 70 % of the
 * history periods. That threshold is deliberately blunt and explainable: the
 * consultant can be told "this supplier was booked in 11 of the last 12 months".
 */
export interface RecurringCost {
  readonly supplierNumber: string;
  readonly account: number;
  readonly periodsSeen: number;
  readonly totalPeriods: number;
  readonly medianNet: Ore;
}

export function findRecurringCosts(
  vouchers: readonly Voucher[],
  historyPeriods: readonly PeriodKey[],
  minRatio = 0.7,
): RecurringCost[] {
  const seen = new Map<string, { periods: Set<PeriodKey>; amounts: Ore[] }>();

  for (const voucher of vouchers) {
    if (!voucher.supplierNumber) continue;
    const period = periodKeyOf(voucher.transactionDate);
    for (const row of voucher.rows) {
      if (!isCostRow(row)) continue;
      const net = row.debit - row.credit;
      if (net <= 0) continue;
      const key = `${voucher.supplierNumber}:${row.account}`;
      const entry = seen.get(key) ?? { periods: new Set<PeriodKey>(), amounts: [] };
      entry.periods.add(period);
      entry.amounts.push(net);
      seen.set(key, entry);
    }
  }

  const total = historyPeriods.length;
  const out: RecurringCost[] = [];
  for (const [key, entry] of seen) {
    const [supplierNumber, accountRaw] = key.split(':');
    if (!supplierNumber || !accountRaw) continue;
    if (total > 0 && entry.periods.size / total >= minRatio) {
      out.push({
        supplierNumber,
        account: Number(accountRaw),
        periodsSeen: entry.periods.size,
        totalPeriods: total,
        medianNet: median(entry.amounts),
      });
    }
  }
  return out.sort((a, b) => a.supplierNumber.localeCompare(b.supplierNumber) || a.account - b.account);
}
