import type {
  HttpFetch,
  HttpRequestInit,
  HttpResponse,
  LedgerSnapshot,
  Voucher,
} from '@trimeros/domain';

/**
 * A fake Fortnox HTTP API, served from a `LedgerSnapshot`.
 *
 * It speaks the wire format the real adapter expects (resource-name wrappers,
 * PascalCase fields, decimal kronor, `MetaInformation` paging, bearer auth,
 * `ErrorInformation` errors) so a close run can be driven end to end through
 * the real adapter without a Fortnox account. It also accepts `POST
 * /3/vouchers` and remembers what was posted, which is how the tests prove
 * that the write gate lets exactly the approved bytes through - and nothing
 * else.
 */

export interface FakeFortnoxOptions {
  readonly accessToken?: string;
  /** Page size for list resources; small values exercise pagination. */
  readonly pageSize?: number;
  readonly companyName?: string;
  readonly organisationNumber?: string;
}

export interface FakeFortnoxCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
  readonly authorized: boolean;
}

export interface FakeFortnoxServer {
  readonly fetchImpl: HttpFetch;
  readonly calls: FakeFortnoxCall[];
  /** Vouchers created through POST, in order. */
  readonly created: { readonly series: string; readonly number: number; readonly year: number; readonly body: unknown }[];
  /** Fortnox's integer id for one of the snapshot's financial years. */
  financialYearId(id: string): number;
}

export function createFakeFortnoxServer(
  snapshot: LedgerSnapshot & { readonly lockedThrough: string | null },
  options: FakeFortnoxOptions = {},
): FakeFortnoxServer {
  const token = options.accessToken ?? 'fake-access-token';
  const pageSize = options.pageSize ?? 500;
  const calls: FakeFortnoxCall[] = [];
  const created: FakeFortnoxServer['created'] = [];

  const yearIds = new Map(snapshot.financialYears.map((y, i) => [y.id, i + 1]));
  const yearOf = (date: string): number => {
    const year = snapshot.financialYears.find((y) => y.fromDate <= date && date <= y.toDate);
    return year ? (yearIds.get(year.id) ?? 0) : 0;
  };
  const kr = (ore: number): number => Number((ore / 100).toFixed(2));
  const krText = (ore: number): string => (ore / 100).toFixed(2);

  const voucherHead = (v: Voucher) => ({
    '@url': `https://api.fortnox.example/3/vouchers/${v.series}/${v.number}`,
    VoucherSeries: v.series,
    VoucherNumber: v.number,
    Year: yearOf(v.transactionDate),
    TransactionDate: v.transactionDate,
    Description: v.description,
    ReferenceNumber: v.supplierInvoiceNumber ?? v.customerInvoiceNumber ?? '',
    ReferenceType: v.supplierInvoiceNumber
      ? 'SUPPLIERINVOICE'
      : v.customerInvoiceNumber
        ? 'INVOICE'
        : v.manual
          ? 'MANUAL'
          : 'INVOICEPAYMENT',
  });

  const nextNumber = (series: string): number => {
    const existing = snapshot.vouchers.filter((v) => v.series === series).map((v) => v.number);
    const posted = created.filter((c) => c.series === series).map((c) => c.number);
    return Math.max(0, ...existing, ...posted) + 1;
  };

  function page<T>(items: T[], query: Record<string, string>, key: string) {
    const limit = Math.min(Number(query.limit ?? pageSize) || pageSize, pageSize);
    const current = Math.max(1, Number(query.page ?? 1) || 1);
    const totalPages = Math.max(1, Math.ceil(items.length / limit));
    return {
      MetaInformation: { '@TotalResources': items.length, '@TotalPages': totalPages, '@CurrentPage': current },
      [key]: items.slice((current - 1) * limit, current * limit),
    };
  }

  const routes: Record<string, (q: Record<string, string>, body: unknown) => [number, unknown]> = {
    'GET /3/companyinformation': () => [
      200,
      {
        CompanyInformation: {
          CompanyName: options.companyName ?? 'Nordvik Bygg AB',
          OrganizationNumber: options.organisationNumber ?? '556123-4567',
        },
      },
    ],
    'GET /3/financialyears': (q) => [
      200,
      page(
        snapshot.financialYears.map((y) => ({
          Id: yearIds.get(y.id),
          FromDate: y.fromDate,
          ToDate: y.toDate,
          AccountingMethod: 'ACCRUAL',
          accountCharts: y.accountChartType,
        })),
        q,
        'FinancialYears',
      ),
    ],
    'GET /3/accounts': (q) => [
      200,
      page(
        snapshot.accounts.map((a) => ({
          Number: a.number,
          Description: a.description,
          Active: a.active,
          VATCode: a.vatCode ?? '',
          CostCenterSettings: a.costCenterRequired ? 'MANDATORY' : 'ALLOWED',
          ProjectSettings: a.projectRequired ? 'MANDATORY' : 'ALLOWED',
          Year: Number(q.financialyear ?? 0),
        })),
        q,
        'Accounts',
      ),
    ],
    'GET /3/voucherseries': (q) => [
      200,
      page(
        snapshot.voucherSeries.map((s) => ({ Code: s.code, Description: s.description, Manual: s.manual, Year: s.year ?? undefined })),
        q,
        'VoucherSeriesCollection',
      ),
    ],
    'GET /3/vouchers': (q) => {
      const year = Number(q.financialyear ?? 0);
      const items = snapshot.vouchers
        .filter((v) => (year ? yearOf(v.transactionDate) === year : true))
        .filter((v) => (q.fromdate ? v.transactionDate >= q.fromdate : true))
        .filter((v) => (q.todate ? v.transactionDate <= q.todate : true))
        .map(voucherHead);
      return [200, page(items, q, 'Vouchers')];
    },
    'GET /3/voucherfileconnections': (q) => [
      200,
      page(
        snapshot.vouchers
          .filter((v) => v.hasFileConnection)
          .map((v) => ({
            FileId: `file-${v.id}`,
            VoucherSeries: v.series,
            VoucherNumber: String(v.number),
            VoucherYear: yearOf(v.transactionDate),
          })),
        q,
        'VoucherFileConnections',
      ),
    ],
    'GET /3/suppliers': (q) => [
      200,
      page(
        snapshot.suppliers.map((s) => ({
          SupplierNumber: s.supplierNumber,
          Name: s.name,
          OrganisationNumber: s.organisationNumber ?? '',
          Active: s.active,
        })),
        q,
        'Suppliers',
      ),
    ],
    'GET /3/customers': (q) => [
      200,
      page(
        snapshot.customers.map((c) => ({
          CustomerNumber: c.customerNumber,
          Name: c.name,
          OrganisationNumber: c.organisationNumber ?? '',
          Active: c.active,
        })),
        q,
        'Customers',
      ),
    ],
    'GET /3/supplierinvoices': (q) => [
      200,
      page(
        snapshot.supplierInvoices.map((i) => {
          const voucher = snapshot.vouchers.find((v) => v.supplierInvoiceNumber === i.givenNumber);
          return {
            GivenNumber: i.givenNumber,
            SupplierNumber: i.supplierNumber,
            SupplierName: i.supplierName,
            InvoiceDate: i.invoiceDate,
            DueDate: i.dueDate,
            Total: krText(i.total),
            Currency: i.currency,
            Booked: i.booked,
            Cancelled: false,
            Vouchers: voucher
              ? [{ Number: voucher.number, Year: yearOf(voucher.transactionDate), Series: voucher.series, ReferenceType: 'SUPPLIERINVOICE' }]
              : [],
          };
        }),
        q,
        'SupplierInvoices',
      ),
    ],
    'GET /3/supplierinvoicefileconnections': (q) => [
      200,
      page(
        snapshot.supplierInvoices
          .filter((i) => i.hasFileConnection)
          .map((i) => ({ FileId: `file-${i.id}`, SupplierInvoiceNumber: i.givenNumber })),
        q,
        'SupplierInvoiceFileConnections',
      ),
    ],
    'GET /3/invoices': (q) => [
      200,
      page(
        snapshot.customerInvoices
          .filter((i) => (q.fromdate ? i.invoiceDate >= q.fromdate : true))
          .filter((i) => (q.todate ? i.invoiceDate <= q.todate : true))
          .map((i) => {
            const voucher = snapshot.vouchers.find((v) => v.customerInvoiceNumber === i.documentNumber);
            return {
              DocumentNumber: i.documentNumber,
              CustomerNumber: i.customerNumber,
              CustomerName: i.customerName,
              InvoiceDate: i.invoiceDate,
              DueDate: i.dueDate,
              Total: kr(i.total),
              Balance: i.fullyPaid ? 0 : kr(i.total),
              Currency: i.currency,
              Booked: i.booked,
              Cancelled: false,
              ...(voucher
                ? { VoucherNumber: voucher.number, VoucherSeries: voucher.series, VoucherYear: yearOf(voucher.transactionDate) }
                : {}),
            };
          }),
        q,
        'Invoices',
      ),
    ],
    'GET /3/supplierinvoicepayments': (q) => [
      200,
      page(
        snapshot.payments
          .filter((p) => p.kind === 'supplier_invoice_payment')
          .map((p, i) => ({
            Number: i + 1,
            InvoiceNumber: snapshot.supplierInvoices.find((si) => si.id === p.invoiceId)?.givenNumber ?? p.invoiceId,
            PaymentDate: p.paymentDate,
            Amount: kr(p.amount),
            Booked: p.booked,
          })),
        q,
        'SupplierInvoicePayments',
      ),
    ],
    'GET /3/invoicepayments': (q) => [
      200,
      page(
        snapshot.payments
          .filter((p) => p.kind === 'customer_invoice_payment')
          .map((p, i) => ({
            Number: String(i + 1),
            InvoiceNumber: snapshot.customerInvoices.find((ci) => ci.id === p.invoiceId)?.documentNumber ?? p.invoiceId,
            PaymentDate: p.paymentDate,
            Amount: kr(p.amount),
            Booked: p.booked,
          })),
        q,
        'InvoicePayments',
      ),
    ],
    'GET /3/costcenters': (q) => [
      200,
      page(snapshot.costCenters.map((c) => ({ Code: c.code, Description: c.description, Active: c.active })), q, 'CostCenters'),
    ],
    'GET /3/projects': (q) => [
      200,
      page(
        snapshot.projects.map((p) => ({ ProjectNumber: p.projectNumber, Description: p.description, Status: p.status.toUpperCase() })),
        q,
        'Projects',
      ),
    ],
    'GET /3/settings/lockedperiod': () =>
      snapshot.lockedThrough
        ? [200, { LockedPeriod: { EndDate: snapshot.lockedThrough } }]
        : [404, { ErrorInformation: { Error: 1, Message: 'Ingen låst period', Code: 2000422 } }],
    'POST /3/vouchers': (q, body) => {
      const voucher = (body as { Voucher?: { VoucherSeries?: string; TransactionDate?: string; VoucherRows?: unknown[] } }).Voucher;
      if (!voucher?.VoucherSeries || !voucher.TransactionDate || !Array.isArray(voucher.VoucherRows) || voucher.VoucherRows.length === 0) {
        return [400, { ErrorInformation: { Error: 1, Message: 'Ogiltig verifikation', Code: 2000357 } }];
      }
      const number = nextNumber(voucher.VoucherSeries);
      const year = Number(q.financialyear ?? 0) || yearOf(voucher.TransactionDate);
      created.push({ series: voucher.VoucherSeries, number, year, body });
      return [201, { Voucher: { ...voucher, VoucherNumber: number, Year: year } }];
    },
  };

  const fetchImpl: HttpFetch = async (rawUrl: string, init: HttpRequestInit = {}): Promise<HttpResponse> => {
    const url = new URL(rawUrl);
    const method = (init.method ?? 'GET').toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    const authorized = init.headers?.Authorization === `Bearer ${token}`;
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, path: url.pathname, query, body, authorized });

    if (!authorized) {
      return respond(401, { ErrorInformation: { Error: 1, Message: 'Ogiltig token', Code: 2000310 } });
    }

    const detail = /^\/3\/vouchers\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && detail) {
      const [, series, number] = detail;
      const voucher = snapshot.vouchers.find((v) => v.series === series && v.number === Number(number));
      if (!voucher) return respond(404, { ErrorInformation: { Error: 1, Message: 'Hittades inte', Code: 2000422 } });
      return respond(200, {
        Voucher: {
          ...voucherHead(voucher),
          VoucherRows: voucher.rows.map((r) => ({
            Account: r.account,
            Debit: kr(r.debit),
            Credit: kr(r.credit),
            TransactionInformation: r.description,
            ...(r.costCenter ? { CostCenter: r.costCenter } : {}),
            ...(r.project ? { Project: r.project } : {}),
            Removed: false,
          })),
        },
      });
    }

    const route = routes[`${method} ${url.pathname}`];
    if (!route) return respond(404, { ErrorInformation: { Error: 1, Message: `Okänd resurs ${url.pathname}`, Code: 2000422 } });
    const [status, payload] = route(query, body);
    return respond(status, payload);
  };

  return {
    fetchImpl,
    calls,
    created,
    financialYearId: (id) => yearIds.get(id) ?? 0,
  };
}

function respond(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}
