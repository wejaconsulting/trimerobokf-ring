import {
  type BankTransaction,
  type CostCenter,
  type Customer,
  type CustomerInvoice,
  type FinancialYear,
  type IsoDate,
  type Payment,
  type PeriodKey,
  type Project,
  type Supplier,
  type SupplierInvoice,
  type Voucher,
  type VoucherRow,
  type VoucherSeries,
  addMonths,
  sek,
} from '@trimeros/domain';
import { buildAccounts } from './accounts.js';

/**
 * A fully synthetic Swedish consultancy: Nordvik Konsult AB.
 *
 * Nothing here comes from a real company or a real Fortnox account. The data
 * is built so that a close run over the current period produces a mix of
 * clean items, items that need review and items that block the period - which
 * is exactly what makes the demo meaningful.
 */

export const DEMO_CLIENT = {
  name: 'Nordvik Konsult AB',
  organisationNumber: '556677-8899',
  fortnoxCompanyRef: 'demo-nordvik',
} as const;

/** The period the demo close run analyses. */
export const DEMO_PERIOD: PeriodKey = '2025-08';
/** 12 full months of history precede the demo period. */
export const DEMO_HISTORY_MONTHS = 12;

/** Every period the dataset covers, oldest first. */
export function demoPeriods(): PeriodKey[] {
  return monthsBetween(addMonths(DEMO_PERIOD, -DEMO_HISTORY_MONTHS), DEMO_PERIOD);
}

const CURRENT_PERIOD = DEMO_PERIOD;
const FIRST_PERIOD = addMonths(CURRENT_PERIOD, -DEMO_HISTORY_MONTHS);

export interface SyntheticDataset {
  readonly accounts: ReturnType<typeof buildAccounts>;
  readonly vouchers: Voucher[];
  readonly suppliers: Supplier[];
  readonly customers: Customer[];
  readonly supplierInvoices: SupplierInvoice[];
  readonly customerInvoices: CustomerInvoice[];
  readonly payments: Payment[];
  readonly bankTransactions: BankTransaction[];
  readonly costCenters: CostCenter[];
  readonly projects: Project[];
  readonly financialYears: FinancialYear[];
  readonly voucherSeries: VoucherSeries[];
  readonly lockedThrough: IsoDate | null;
}

const SUPPLIERS: readonly (Supplier & { readonly account: number; readonly monthlyNet: number })[] = [
  { supplierNumber: 'L001', name: 'Fastighets AB Kungsgatan 12', organisationNumber: '556101-1111', active: true, account: 5010, monthlyNet: sek(25000) },
  { supplierNumber: 'L002', name: 'Saasbolaget Nordic AB', organisationNumber: '556202-2222', active: true, account: 6540, monthlyNet: sek(4900) },
  { supplierNumber: 'L003', name: 'Handelsbanken', organisationNumber: '502007-7862', active: true, account: 6570, monthlyNet: sek(250) },
  { supplierNumber: 'L004', name: 'Telia Sverige AB', organisationNumber: '556404-4444', active: true, account: 6212, monthlyNet: sek(1180) },
  { supplierNumber: 'L005', name: 'Kontorsdepån Svenska AB', organisationNumber: '556505-5555', active: true, account: 6110, monthlyNet: sek(2400) },
  { supplierNumber: 'L007', name: 'Städbolaget Ren & Fin AB', organisationNumber: '556707-7777', active: true, account: 5460, monthlyNet: sek(3500) },
  { supplierNumber: 'L008', name: 'Konferens & Event i Väst AB', organisationNumber: '556808-8888', active: true, account: 6110, monthlyNet: sek(1800) },
];

/** Appears for the first time in the current period - no history to compare against. */
const NEW_SUPPLIER: Supplier = {
  supplierNumber: 'L006',
  name: 'Elektrikern i Väst AB',
  organisationNumber: '556606-6666',
  active: true,
};

const CUSTOMERS: readonly (Customer & { readonly monthlyNet: number })[] = [
  { customerNumber: 'K001', name: 'Volvo Personvagnar AB', organisationNumber: '556074-3089', active: true, monthlyNet: sek(100000) },
  { customerNumber: 'K002', name: 'Skanska Sverige AB', organisationNumber: '556033-9086', active: true, monthlyNet: sek(48000) },
];

const COST_CENTERS: CostCenter[] = [
  { code: 'ADM', description: 'Administration', active: true },
  { code: 'KONS', description: 'Konsultverksamhet', active: true },
  { code: 'SALJ', description: 'Försäljning', active: true },
];

const PROJECTS: Project[] = [
  { projectNumber: 'P100', description: 'Kundprojekt Alfa', status: 'ongoing' },
  { projectNumber: 'P200', description: 'Internt utvecklingsprojekt', status: 'ongoing' },
];

const VOUCHER_SERIES: VoucherSeries[] = [
  { code: 'A', description: 'Manuella verifikationer', manual: true, year: null },
  { code: 'B', description: 'Kundfakturor', manual: false, year: null },
  { code: 'C', description: 'Inbetalningar', manual: false, year: null },
  { code: 'LF', description: 'Leverantörsfakturor', manual: false, year: null },
  { code: 'D', description: 'Utbetalningar', manual: false, year: null },
];

const VAT_RATE = 0.25;

/** Deterministic pseudo-random in [0,1) so every seed run is byte-identical. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function periodDate(period: PeriodKey, day: number): IsoDate {
  return `${period}-${String(day).padStart(2, '0')}`;
}

function monthsBetween(from: PeriodKey, to: PeriodKey): PeriodKey[] {
  const out: PeriodKey[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

interface RowInput {
  account: number;
  debit?: number;
  credit?: number;
  description?: string;
  costCenter?: string | null;
  project?: string | null;
  vatCode?: string | null;
}

class Builder {
  readonly vouchers: Voucher[] = [];
  readonly supplierInvoices: SupplierInvoice[] = [];
  readonly customerInvoices: CustomerInvoice[] = [];
  readonly payments: Payment[] = [];
  readonly bankTransactions: BankTransaction[] = [];
  #numbers = new Map<string, number>();

  voucher(
    input: {
      series: string;
      date: IsoDate;
      description: string;
      manual?: boolean;
      hasFileConnection?: boolean;
      supplierNumber?: string | null;
      customerNumber?: string | null;
      supplierInvoiceNumber?: string | null;
      customerInvoiceNumber?: string | null;
    },
    rows: readonly RowInput[],
  ): Voucher {
    const next = (this.#numbers.get(input.series) ?? 0) + 1;
    this.#numbers.set(input.series, next);
    const id = `${input.series}${next}-${input.date}`;
    const voucher: Voucher = {
      id,
      series: input.series,
      number: next,
      transactionDate: input.date,
      description: input.description,
      manual: input.manual ?? false,
      hasFileConnection: input.hasFileConnection ?? true,
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      customerInvoiceNumber: input.customerInvoiceNumber ?? null,
      supplierNumber: input.supplierNumber ?? null,
      customerNumber: input.customerNumber ?? null,
      rows: rows.map((r, i): VoucherRow => ({
        id: `${id}#${i + 1}`,
        account: r.account,
        debit: r.debit ?? 0,
        credit: r.credit ?? 0,
        description: r.description ?? input.description,
        costCenter: r.costCenter ?? null,
        project: r.project ?? null,
        vatCode: r.vatCode ?? null,
      })),
    };
    this.vouchers.push(voucher);
    return voucher;
  }
}

/**
 * Books a purchase invoice the way Fortnox's supplier invoice module would:
 * cost account debit, input VAT debit, supplier debt credit.
 */
function supplierInvoiceRows(opts: {
  account: number;
  net: number;
  vat: number;
  costCenter: string | null;
  project?: string | null;
  vatCode?: string | null;
}): RowInput[] {
  const rows: RowInput[] = [
    {
      account: opts.account,
      debit: opts.net,
      costCenter: opts.costCenter,
      project: opts.project ?? null,
      vatCode: opts.vatCode ?? 'MP1',
    },
  ];
  if (opts.vat > 0) rows.push({ account: 2641, debit: opts.vat, vatCode: 'I25' });
  rows.push({ account: 2440, credit: opts.net + opts.vat });
  return rows;
}

export function buildSyntheticDataset(): SyntheticDataset {
  const b = new Builder();
  const history = monthsBetween(FIRST_PERIOD, addMonths(CURRENT_PERIOD, -1));

  // ---------------------------------------------------------------------
  // 1. Twelve months of ordinary, well-behaved bookkeeping.
  // ---------------------------------------------------------------------
  let seedCounter = 1;
  for (const period of history) {
    buildOrdinaryMonth(b, period, () => seedCounter++);
  }

  // ---------------------------------------------------------------------
  // 2. The current period: mostly ordinary, with deliberate exceptions.
  // ---------------------------------------------------------------------
  buildCurrentMonth(b, CURRENT_PERIOD, () => seedCounter++);

  const suppliers: Supplier[] = [
    ...SUPPLIERS.map(({ supplierNumber, name, organisationNumber, active }) => ({
      supplierNumber,
      name,
      organisationNumber,
      active,
    })),
    NEW_SUPPLIER,
  ];

  const customers: Customer[] = CUSTOMERS.map(({ customerNumber, name, organisationNumber, active }) => ({
    customerNumber,
    name,
    organisationNumber,
    active,
  }));

  const financialYears: FinancialYear[] = [
    { id: 'fy-2024', fromDate: '2024-01-01', toDate: '2024-12-31', accountChartType: 'Bas 2024' },
    { id: 'fy-2025', fromDate: '2025-01-01', toDate: '2025-12-31', accountChartType: 'Bas 2025' },
  ];

  return {
    accounts: buildAccounts(),
    vouchers: b.vouchers,
    suppliers,
    customers,
    supplierInvoices: b.supplierInvoices,
    customerInvoices: b.customerInvoices,
    payments: b.payments,
    bankTransactions: b.bankTransactions,
    costCenters: COST_CENTERS,
    projects: PROJECTS,
    financialYears,
    voucherSeries: VOUCHER_SERIES,
    // The prior period is locked; the period under analysis is open.
    lockedThrough: lastDay(addMonths(CURRENT_PERIOD, -1)),
  };
}

function buildOrdinaryMonth(b: Builder, period: PeriodKey, nextSeed: () => number): void {
  // --- recurring supplier invoices ---------------------------------------
  for (const s of SUPPLIERS) {
    // Slight, realistic variation on the variable suppliers only.
    const variable = s.supplierNumber === 'L005' || s.supplierNumber === 'L008';
    const net = variable
      ? Math.round(s.monthlyNet * (0.85 + rand(nextSeed()) * 0.3))
      : s.monthlyNet;
    const vat = s.account === 6570 ? 0 : Math.round(net * VAT_RATE);
    const day = 3 + (s.supplierNumber.charCodeAt(3) % 12);
    const date = periodDate(period, day);
    const invoiceNumber = `${s.supplierNumber}-${period.replace('-', '')}`;

    b.supplierInvoices.push({
      id: `si-${invoiceNumber}`,
      givenNumber: invoiceNumber,
      supplierNumber: s.supplierNumber,
      supplierName: s.name,
      invoiceDate: date,
      dueDate: periodDate(addMonths(period, 1), 15),
      total: net + vat,
      vatAmount: vat,
      currency: 'SEK',
      booked: true,
      hasFileConnection: true,
      voucherId: null,
    });

    b.voucher(
      {
        series: 'LF',
        date,
        description: `Leverantörsfaktura ${s.name}`,
        supplierNumber: s.supplierNumber,
        supplierInvoiceNumber: invoiceNumber,
        hasFileConnection: true,
      },
      supplierInvoiceRows({
        account: s.account,
        net,
        vat,
        costCenter: costCenterFor(s.account),
        project: s.account === 5010 ? null : projectFor(s.supplierNumber),
      }),
    );
  }

  // --- customer invoices --------------------------------------------------
  for (const c of CUSTOMERS) {
    const net = Math.round(c.monthlyNet * (0.9 + rand(nextSeed()) * 0.2));
    const vat = Math.round(net * VAT_RATE);
    const date = periodDate(period, 25);
    const docNumber = `${c.customerNumber}-${period.replace('-', '')}`;

    b.customerInvoices.push({
      id: `ci-${docNumber}`,
      documentNumber: docNumber,
      customerNumber: c.customerNumber,
      customerName: c.name,
      invoiceDate: date,
      dueDate: periodDate(addMonths(period, 1), 24),
      total: net + vat,
      vatAmount: vat,
      currency: 'SEK',
      booked: true,
      fullyPaid: true,
      voucherId: null,
    });

    b.voucher(
      {
        series: 'B',
        date,
        description: `Kundfaktura ${c.name}`,
        customerNumber: c.customerNumber,
        customerInvoiceNumber: docNumber,
      },
      [
        { account: 1510, debit: net + vat },
        { account: 3011, credit: net, costCenter: 'KONS', project: 'P100', vatCode: 'MP1' },
        { account: 2611, credit: vat, vatCode: 'U25' },
      ],
    );

    // Payment in the following month.
    const payDate = periodDate(addMonths(period, 1), 20);
    b.payments.push({
      id: `pay-ci-${docNumber}`,
      kind: 'customer_invoice_payment',
      invoiceId: `ci-${docNumber}`,
      paymentDate: payDate,
      amount: net + vat,
      booked: true,
    });
    b.bankTransactions.push({
      id: `bt-in-${docNumber}`,
      bookingDate: payDate,
      amount: net + vat,
      text: `Inbetalning ${c.name}`,
      account: 1930,
      matchedInvoiceId: `ci-${docNumber}`,
      matchedVoucherId: null,
    });
  }

  // --- monthly depreciation (manual A voucher, entirely routine) ----------
  b.voucher(
    { series: 'A', date: lastDay(period), description: 'Månadens avskrivning inventarier', manual: true },
    [
      { account: 7830, debit: sek(2500), costCenter: 'ADM' },
      { account: 1229, credit: sek(2500) },
    ],
  );
}

function buildCurrentMonth(b: Builder, period: PeriodKey, nextSeed: () => number): void {
  // Ordinary, clean postings for the well-behaved suppliers. L001 (rent) is
  // deliberately ABSENT - that is the "missing recurring cost" case.
  for (const s of SUPPLIERS) {
    if (['L001', 'L002', 'L004', 'L005', 'L007', 'L008'].includes(s.supplierNumber)) continue;
    const net = s.monthlyNet;
    const vat = s.account === 6570 ? 0 : Math.round(net * VAT_RATE);
    const date = periodDate(period, 5);
    const invoiceNumber = `${s.supplierNumber}-${period.replace('-', '')}`;
    b.supplierInvoices.push({
      id: `si-${invoiceNumber}`,
      givenNumber: invoiceNumber,
      supplierNumber: s.supplierNumber,
      supplierName: s.name,
      invoiceDate: date,
      dueDate: periodDate(addMonths(period, 1), 15),
      total: net + vat,
      vatAmount: vat,
      currency: 'SEK',
      booked: true,
      hasFileConnection: true,
      voucherId: null,
    });
    b.voucher(
      {
        series: 'LF',
        date,
        description: `Leverantörsfaktura ${s.name}`,
        supplierNumber: s.supplierNumber,
        supplierInvoiceNumber: invoiceNumber,
      },
      supplierInvoiceRows({ account: s.account, net, vat, costCenter: costCenterFor(s.account) }),
    );
  }

  // Customer invoices continue as normal (clean).
  for (const c of CUSTOMERS) {
    const net = Math.round(c.monthlyNet * (0.9 + rand(nextSeed()) * 0.2));
    const vat = Math.round(net * VAT_RATE);
    const date = periodDate(period, 25);
    const docNumber = `${c.customerNumber}-${period.replace('-', '')}`;
    b.customerInvoices.push({
      id: `ci-${docNumber}`,
      documentNumber: docNumber,
      customerNumber: c.customerNumber,
      customerName: c.name,
      invoiceDate: date,
      dueDate: periodDate(addMonths(period, 1), 24),
      total: net + vat,
      vatAmount: vat,
      currency: 'SEK',
      booked: true,
      fullyPaid: false,
      voucherId: null,
    });
    b.voucher(
      { series: 'B', date, description: `Kundfaktura ${c.name}`, customerNumber: c.customerNumber, customerInvoiceNumber: docNumber },
      [
        { account: 1510, debit: net + vat },
        { account: 3011, credit: net, costCenter: 'KONS', project: 'P100', vatCode: 'MP1' },
        { account: 2611, credit: vat, vatCode: 'U25' },
      ],
    );
  }

  // Routine depreciation - clean.
  b.voucher(
    { series: 'A', date: lastDay(period), description: 'Månadens avskrivning inventarier', manual: true },
    [
      { account: 7830, debit: sek(2500), costCenter: 'ADM' },
      { account: 1229, credit: sek(2500) },
    ],
  );

  // --- Exception 1: the same supplier invoice booked twice ----------------
  // One invoice, two vouchers. Both the deterministic duplicate-source-record
  // validation and the fuzzy possible-duplicate rule react to it, which is how
  // the demo shows two checks collapsing into a single finding.
  const saasNet = sek(4900);
  const saasVat = Math.round(saasNet * VAT_RATE);
  const saasInvoiceNumber = `L002-${period.replace('-', '')}`;
  b.supplierInvoices.push({
    id: `si-${saasInvoiceNumber}`,
    givenNumber: saasInvoiceNumber,
    supplierNumber: 'L002',
    supplierName: 'Saasbolaget Nordic AB',
    invoiceDate: periodDate(period, 8),
    dueDate: periodDate(addMonths(period, 1), 15),
    total: saasNet + saasVat,
    vatAmount: saasVat,
    currency: 'SEK',
    booked: true,
    hasFileConnection: true,
    voucherId: null,
  });
  for (let i = 0; i < 2; i++) {
    b.voucher(
      {
        series: 'LF',
        date: periodDate(period, 8),
        description: 'Leverantörsfaktura Saasbolaget Nordic AB',
        supplierNumber: 'L002',
        supplierInvoiceNumber: saasInvoiceNumber,
      },
      supplierInvoiceRows({ account: 6540, net: saasNet, vat: saasVat, costCenter: 'ADM' }),
    );
  }

  // --- Exception 2: Telia booked to an account it never uses (5910) -------
  const telNet = sek(1180);
  const telVat = Math.round(telNet * VAT_RATE);
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 9),
      description: 'Leverantörsfaktura Telia Sverige AB',
      supplierNumber: 'L004',
      supplierInvoiceNumber: `L004-${period.replace('-', '')}`,
    },
    supplierInvoiceRows({ account: 5910, net: telNet, vat: telVat, costCenter: 'SALJ' }),
  );
  b.supplierInvoices.push({
    id: `si-L004-${period.replace('-', '')}`,
    givenNumber: `L004-${period.replace('-', '')}`,
    supplierNumber: 'L004',
    supplierName: 'Telia Sverige AB',
    invoiceDate: periodDate(period, 9),
    dueDate: periodDate(addMonths(period, 1), 15),
    total: telNet + telVat,
    vatAmount: telVat,
    currency: 'SEK',
    booked: true,
    hasFileConnection: true,
    voucherId: null,
  });

  // --- Exception 3: missing receipt, input VAT deducted anyway (BLOCKING) --
  const officeNet = sek(2400);
  const officeVat = Math.round(officeNet * VAT_RATE);
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 11),
      description: 'Leverantörsfaktura Kontorsdepån Svenska AB',
      supplierNumber: 'L005',
      supplierInvoiceNumber: `L005-${period.replace('-', '')}`,
      hasFileConnection: false,
    },
    supplierInvoiceRows({ account: 6110, net: officeNet, vat: officeVat, costCenter: 'ADM' }),
  );
  b.supplierInvoices.push({
    id: `si-L005-${period.replace('-', '')}`,
    givenNumber: `L005-${period.replace('-', '')}`,
    supplierNumber: 'L005',
    supplierName: 'Kontorsdepån Svenska AB',
    invoiceDate: periodDate(period, 11),
    dueDate: periodDate(addMonths(period, 1), 15),
    total: officeNet + officeVat,
    vatAmount: officeVat,
    currency: 'SEK',
    booked: true,
    hasFileConnection: false,
    voucherId: null,
  });

  // --- Exception 4: brand new supplier, no history to compare against -----
  const elNet = sek(18500);
  const elVat = Math.round(elNet * VAT_RATE);
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 12),
      description: 'Leverantörsfaktura Elektrikern i Väst AB',
      supplierNumber: 'L006',
      supplierInvoiceNumber: `L006-${period.replace('-', '')}`,
    },
    supplierInvoiceRows({ account: 5410, net: elNet, vat: elVat, costCenter: 'KONS' }),
  );
  b.supplierInvoices.push({
    id: `si-L006-${period.replace('-', '')}`,
    givenNumber: `L006-${period.replace('-', '')}`,
    supplierNumber: 'L006',
    supplierName: 'Elektrikern i Väst AB',
    invoiceDate: periodDate(period, 12),
    dueDate: periodDate(addMonths(period, 1), 15),
    total: elNet + elVat,
    vatAmount: elVat,
    currency: 'SEK',
    booked: true,
    hasFileConnection: true,
    voucherId: null,
  });

  // --- Exception 5: cleaning invoice four times the usual amount ----------
  const cleanNet = sek(14000);
  const cleanVat = Math.round(cleanNet * VAT_RATE);
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 6),
      description: 'Leverantörsfaktura Städbolaget Ren & Fin AB',
      supplierNumber: 'L007',
      supplierInvoiceNumber: `L007-${period.replace('-', '')}`,
    },
    supplierInvoiceRows({ account: 5460, net: cleanNet, vat: cleanVat, costCenter: 'ADM' }),
  );
  b.supplierInvoices.push({
    id: `si-L007-${period.replace('-', '')}`,
    givenNumber: `L007-${period.replace('-', '')}`,
    supplierNumber: 'L007',
    supplierName: 'Städbolaget Ren & Fin AB',
    invoiceDate: periodDate(period, 6),
    dueDate: periodDate(addMonths(period, 1), 15),
    total: cleanNet + cleanVat,
    vatAmount: cleanVat,
    currency: 'SEK',
    booked: true,
    hasFileConnection: true,
    voucherId: null,
  });

  // --- Exception 6: same supplier posted to a balance account -------------
  // Historically L007 always hits result account 5460; here it lands on 1790.
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 7),
      description: 'Leverantörsfaktura Städbolaget Ren & Fin AB (förskott)',
      supplierNumber: 'L007',
      supplierInvoiceNumber: `L007-${period.replace('-', '')}-b`,
    },
    supplierInvoiceRows({ account: 1790, net: sek(3500), vat: sek(875), costCenter: null }),
  );

  // --- Exception 7: wrong VAT code on a 25 % purchase ---------------------
  const confNet = sek(1800);
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 14),
      description: 'Leverantörsfaktura Konferens & Event i Väst AB',
      supplierNumber: 'L008',
      supplierInvoiceNumber: `L008-${period.replace('-', '')}`,
    },
    supplierInvoiceRows({
      account: 6110,
      net: confNet,
      vat: Math.round(confNet * VAT_RATE),
      costCenter: 'ADM',
      // MP2 is the 12 % code; the amount booked is 25 %.
      vatCode: 'MP2',
    }),
  );

  // --- Exception 8: June invoice booked in August (wrong period) ----------
  b.voucher(
    {
      series: 'LF',
      date: periodDate(period, 10),
      description: 'Leverantörsfaktura Telia Sverige AB (juni)',
      supplierNumber: 'L004',
      supplierInvoiceNumber: `L004-${addMonths(period, -2).replace('-', '')}`,
    },
    supplierInvoiceRows({ account: 6212, net: sek(1180), vat: sek(295), costCenter: 'ADM' }),
  );
  b.supplierInvoices.push({
    id: `si-L004-${addMonths(period, -2).replace('-', '')}`,
    givenNumber: `L004-${addMonths(period, -2).replace('-', '')}`,
    supplierNumber: 'L004',
    supplierName: 'Telia Sverige AB',
    invoiceDate: periodDate(addMonths(period, -2), 15),
    dueDate: periodDate(addMonths(period, -1), 15),
    total: sek(1475),
    vatAmount: sek(295),
    currency: 'SEK',
    booked: true,
    hasFileConnection: true,
    voucherId: null,
  });

  // --- Exception 9: large manual A voucher on an unusual account ----------
  b.voucher(
    {
      series: 'A',
      date: periodDate(period, 28),
      description: 'Omföring enligt instruktion från kund',
      manual: true,
      hasFileConnection: false,
    },
    [
      { account: 6992, debit: sek(45000), description: 'Omföring' },
      { account: 2890, credit: sek(45000), description: 'Omföring' },
    ],
  );

  // --- Exception 10: accrual missing its cost center ----------------------
  b.voucher(
    { series: 'A', date: lastDay(period), description: 'Periodisering försäkring', manual: true },
    [
      { account: 5410, debit: sek(6000), costCenter: null },
      { account: 1790, credit: sek(6000) },
    ],
  );

  // Bank fee outflow, cleanly matched - shows a green item in the UI.
  b.bankTransactions.push({
    id: `bt-out-bankavgift-${period}`,
    bookingDate: periodDate(period, 5),
    amount: -sek(250),
    text: 'Bankavgift Handelsbanken',
    account: 1930,
    matchedInvoiceId: null,
    matchedVoucherId: null,
  });
}

function costCenterFor(account: number): string | null {
  if (account === 5010) return 'ADM';
  if (account === 6540) return 'ADM';
  if (account === 6212) return 'ADM';
  if (account === 5460) return 'ADM';
  if (account === 6110) return 'ADM';
  if (account === 5910) return 'SALJ';
  if (account === 5410) return 'KONS';
  return null;
}

function projectFor(supplierNumber: string): string | null {
  return supplierNumber === 'L002' ? 'P200' : null;
}

function lastDay(period: PeriodKey): IsoDate {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10) as IsoDate;
}
