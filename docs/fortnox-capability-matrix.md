# Fortnox API capability matrix

Verified against the official Fortnox developer documentation on **2026-08-28**.

---

## How to read this document (read this first)

### Verification method and its limits

The official Fortnox developer documentation lives on `www.fortnox.se/developer`,
`developer.fortnox.se` and `api.fortnox.se/apidocs`. **All three hosts are blocked by the
egress policy of the environment this repository was built in.** Direct fetches returned:

```
EGRESS_BLOCKED: Access to www.fortnox.se is blocked by the network egress proxy.
EGRESS_BLOCKED: Access to developer.fortnox.se is blocked by the network egress proxy.
EGRESS_BLOCKED: Access to apps.fortnox.se is blocked by the network egress proxy.
```

Verification was therefore done through a search index that surfaces the content of those
official pages. That is weaker evidence than opening the page, and this document does not
pretend otherwise. Three verification levels are used, and they are the honest ones:

| Level | What it means here |
| --- | --- |
| **verified** | An official Fortnox page states the endpoint path or the behaviour, and that statement was read. |
| **partial** | The official resource page is confirmed to exist for this capability, but the HTTP verbs, scope name, or field-level contract were not read. |
| **requires Fortnox confirmation** | No public API resource was found. The capability appears only as an in-product feature, or not at all. |
| **unavailable** | Actively established as not offered over the public API. |

**Nothing in this matrix should be treated as a contract until a human has opened the
corresponding page on `developer.fortnox.se` with a real developer account.** That
re-verification is the first task of phase 2, and it is the reason every write path in this
codebase is disabled: see [`shadow-mode.md`](./shadow-mode.md).

### What "no endpoint" means in the code

`packages/fortnox/src/endpoints.ts` contains **only** the paths corroborated by official
text or by the published Fortnox OpenAPI specification (see "Response shapes" below).
Capabilities without a corroborated endpoint are listed in `UNVERIFIED_CAPABILITIES` in
that same file, are reported as unavailable by both adapters, and cause the corresponding
workflow steps to report `not_implemented` — which blocks period completion. **No endpoint
in this repository was invented, and no browser automation was implemented as a substitute
for a missing API.**

### Response shapes (the read path)

The real adapter (`packages/fortnox/src/real-adapter.ts`) parses every response through the
schemas in `packages/fortnox/src/wire.ts`. The field names there were taken from client
libraries generated from Fortnox's published OpenAPI specification (`@rantalainen/fortnox-api-client`
1.1.1 and `@moatless/fortnox-client` 0.1.3, downloaded from the npm registry on 2026-09-09; the
official hosts themselves remained blocked). Two independent generated sources agreed on every
field the adapter uses. That is stronger evidence than the search-index method above, and
weaker than a live call: **"partial (OpenAPI-derived)"** in the table below.

| Resource | Path | List key | Fields used | Notes |
| --- | --- | --- | --- | --- |
| Company | `GET /3/companyinformation` | `CompanyInformation` | `CompanyName`, `OrganizationNumber` | connection test |
| Financial years | `GET /3/financialyears` | `FinancialYears` | `Id`, `FromDate`, `ToDate`, `AccountingMethod`, `accountCharts` | `Id` is the `financialyear` query value everywhere else |
| Accounts | `GET /3/accounts?financialyear=` | `Accounts` | `Number`, `Description`, `Active`, `VATCode`, `CostCenterSettings`, `ProjectSettings` | `MANDATORY` → dimension required |
| Voucher series | `GET /3/voucherseries` | `VoucherSeriesCollection` | `Code`, `Description`, `Manual`, `Year` | |
| Vouchers (list) | `GET /3/vouchers?financialyear=&fromdate=&todate=&page=&limit=` | `Vouchers` | `VoucherSeries`, `VoucherNumber`, `Year`, `TransactionDate`, `Description`, `ReferenceType`, `ReferenceNumber` | **no rows in the list view** |
| Voucher (detail) | `GET /3/vouchers/{series}/{number}?financialyear=` | `Voucher` | + `VoucherRows[]`: `Account`, `Debit`, `Credit`, `TransactionInformation`, `Description`, `CostCenter`, `Project`, `Removed` | one call per voucher; removed rows dropped |
| Voucher (create) | `POST /3/vouchers?financialyear=` | `Voucher` | as detail | the only write transport; gated |
| Voucher file connections | `GET /3/voucherfileconnections` | `VoucherFileConnections` | `FileId`, `VoucherSeries`, `VoucherNumber`, `VoucherYear` | drives `hasFileConnection` |
| Suppliers | `GET /3/suppliers` | `Suppliers` | `SupplierNumber`, `Name`, `OrganisationNumber`, `Active` | |
| Customers | `GET /3/customers` | `Customers` | `CustomerNumber`, `Name`, `OrganisationNumber`, `Active` | |
| Supplier invoices | `GET /3/supplierinvoices` | `SupplierInvoices` | `GivenNumber`, `SupplierNumber`, `SupplierName`, `InvoiceDate`, `DueDate`, `Total` (string), `Booked`, `Cancelled`, `Vouchers[]` | no date filter in the API; filtered client-side |
| Supplier invoice file connections | `GET /3/supplierinvoicefileconnections` | `SupplierInvoiceFileConnections` | `FileId`, `SupplierInvoiceNumber` | |
| Customer invoices | `GET /3/invoices?fromdate=&todate=` | `Invoices` | `DocumentNumber`, `CustomerNumber`, `CustomerName`, `InvoiceDate`, `DueDate`, `Total`, `Balance`, `Booked`, `Cancelled`, `VoucherNumber/Series/Year` | |
| Payments | `GET /3/supplierinvoicepayments`, `GET /3/invoicepayments` | `SupplierInvoicePayments`, `InvoicePayments` | `Number`, `InvoiceNumber`, `PaymentDate`, `Amount`, `Booked` | |
| Cost centers | `GET /3/costcenters` | `CostCenters` | `Code`, `Description`, `Active` | |
| Projects | `GET /3/projects` | `Projects` | `ProjectNumber`, `Description`, `Status` | |
| Locked period | `GET /3/settings/lockedperiod` | `LockedPeriod` | `EndDate` | 404 treated as "not locked" |

Cross-cutting, from the same sources: paging is `page` + `limit` (max 500) with
`MetaInformation["@TotalPages"]`; errors arrive as `{ ErrorInformation: { Error, Message, Code } }`;
money is decimal kronor, as numbers on most resources and as strings on supplier invoices. The
adapter converts to integer öre on the way in and never does arithmetic in kronor.

Known fidelity limits of the read path, by design rather than by omission:

- Voucher rows carry **no VAT code** in Fortnox; the account's `VATCode` is the only signal, so
  the rule that compares a row's VAT code to history cannot fire on live data.
- A voucher's supplier is resolved through its `SUPPLIERINVOICE` reference. For a voucher with
  no sub-ledger link, the adapter falls back to the one supplier whose registered name appears
  verbatim in the voucher text - deterministic, and never a choice between candidates.
- The supplier-invoice list view carries no VAT amount; the rules do not use it.

### Cross-cutting facts (verified)

| Fact | Value |
| --- | --- |
| Base URL | `https://api.fortnox.se/3/` |
| Formats | JSON and XML; examples in JSON |
| Rate limit | 25 requests per 5 seconds per access token (≈300/min) |
| Auth | OAuth2 (modified). Access token valid 1 hour, refresh token 45 days; a new refresh token is issued on each refresh and the old one is invalidated. Client credentials for service accounts also exist. |
| Scopes | Limit an integration's access. Adding a scope requires the customer to re-activate the integration. |
| Licensing | The company must hold the Fortnox licence for a resource, independently of scope. |
| Predefined values | Omitted payload fields are filled from account settings; values sent via the API always override them. |
| Change notification | Websockets exist (topics include `invoices`, `supplier-invoices`; event types such as `invoicepayment-bookkeep-v1`). No webhook was verified for vouchers. |
| File upload | `multipart/form-data`; the voucher inbox uses path parameter `Inbox_v`; the returned `Id` is used to connect the file. 5 GB free storage per account. |

---

## Matrix

Legend — **R**ead / **C**reate / **U**pdate / **E**xecute (bookkeep):
`Y` documented, `?` not verified at verb level, `–` not applicable, `N` established as unavailable.

| # | Capability | Required for workflow step | Public API available | R | C | U | E | Required scope | Required Fortnox licence | Endpoint | Verified source | Limitations | Proposed fallback | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Financial years | 1 Agent readiness | Yes | Y | ? | ? | – | `bookkeeping` | Bokföring | `GET /3/financialyears?date={date}` | fortnox.se best-practice guide for vouchers states this exact call and that an empty list means the year must be created | Creating a financial year not verified | Block the run and require the consultant to create the year in Fortnox | **verified** |
| 2 | Accounts and VAT settings | 1, 7 | Yes | Y | ? | ? | – | `bookkeeping` | Bokföring | `GET /3/accounts/{accountNumber}?financialyear={id}` | Same guide: verify the account exists and is active before creating a voucher | VAT code semantics per account not verified field-by-field | Treat the imported `VatCode` as opaque upstream data; anomaly rules compare it to history rather than to an assumed table | **verified** |
| 3 | Voucher series | 1 | Yes | Y | ? | ? | – | `bookkeeping` | Bokföring | `GET /3/voucherseries/{Code}` (with financial-year date parameter) | Official voucher best-practice guide; `voucher-series` resource page exists | Manual vs. automatic series semantics not verified | Use only series the account already has; never create one | **verified** |
| 4 | Vouchers | 6, 7, 10 (read); booking (write) | Yes | Y | Y | ? | – | `bookkeeping` | Bokföring | `GET/POST /3/vouchers`, `GET /3/vouchers/{series}/{number}` | Official guide states vouchers are at `https://api.fortnox.se/3/vouchers/` and require the Bookkeeping scope; create payload and list/detail shapes corroborated by two OpenAPI-derived clients (see "Response shapes") | **Whether a voucher can be updated or deleted was not verified**, and the system never tries. The create payload is confirmed against the OpenAPI shape, not against a live call | Read implemented. Create implemented behind the seven-condition gate; shadow mode keeps it closed | **partial (OpenAPI-derived)** |
| 5 | Locked periods | 1, 7, 14 | Yes (read) | Y | ? | ? | – | `bookkeeping` | Bokföring | `GET /3/settings/lockedperiod` → `LockedPeriod.EndDate` | `developer.fortnox.se/documentation/resources/locked-period/` exists; path and shape from the OpenAPI-derived clients | **Setting** a lock via the API was not verified, and the system never tries | Read implemented; the lock is re-read at submission time and any proposal inside it is refused | **partial (OpenAPI-derived)** |
| 6 | Customers | 2 | Yes | Y | ? | ? | – | `invoice` (not verified) | Fakturering | `/3/customers` (resource documented) | Resource listed in official documentation index | Verb-level and scope name unverified | Import read-only from the mock adapter | **partial** |
| 7 | Customer invoices | 2 | Yes | Y | ? | ? | ? | `invoice` (not verified) | Fakturering | `/3/invoices` | `developer.fortnox.se/documentation/resources/invoices/` exists | Bookkeeping an invoice via the API not verified | Step 2 reports `not_implemented`; invoices are imported as source data only | **partial** |
| 8 | Invoice payments | 2, 3 | Yes | Y | ? | ? | ? | `invoice` (not verified) | Fakturering | `/3/invoicepayments` (resource documented) | Websocket event `invoicepayment-bookkeep-v1` documented, implying a bookkeep operation exists | Verb-level unverified | Read-only import | **partial** |
| 9 | Suppliers | 2, 7 | Yes | Y | ? | ? | – | `supplierinvoice` (not verified) | Leverantörsfakturor | `/3/suppliers` (resource documented) | Official documentation index; "list-view fields added for Accounts, Suppliers, SupplierInvoices and Projects" | Verb-level unverified | Read-only import | **partial** |
| 10 | Supplier invoices | 2 | Yes | Y | ? | ? | ? | `supplierinvoice` (not verified) | Leverantörsfakturor | `/3/supplierinvoices` | Resource documented; websocket topic `supplier-invoices` | Bookkeeping via API not verified | Step 2 reports `not_implemented` | **partial** |
| 11 | Supplier invoice payments | 2, 3 | Yes | Y | ? | ? | ? | `supplierinvoice` (not verified) | Leverantörsfakturor | `/3/supplierinvoicepayments` | `developer.fortnox.se/documentation/resources/supplier-invoice-payments/` exists | Verb-level unverified | Read-only import | **partial** |
| 12 | Invoice accruals | 4 | Yes | Y | ? | ? | – | `bookkeeping` (not verified) | Bokföring | `/3/invoiceaccruals` | `developer.fortnox.se/documentation/resources/invoice-accruals/` exists | Verb-level unverified | Step 4 reports `not_implemented`; accruals are proposed as ordinary vouchers instead | **partial** |
| 13 | Supplier invoice accruals | 4 | Yes | Y | ? | ? | – | `bookkeeping` (not verified) | Bokföring | `/3/supplierinvoiceaccruals` | `developer.fortnox.se/documentation/resources/supplier-invoice-accruals/` exists | Verb-level unverified | As above | **partial** |
| 14 | Assets | 4 | Yes | Y | ? | ? | – | `assets` (not verified) | Anläggningsregister | `/3/assets`, `/3/assets/types/{Id}` | `resources/asset/` and `resources/asset-types/` exist; official text describes `https://api.fortnox.se/3/assets/types/{Id}` returning one or many | Asset types carry `AccountDepreciationId` / `AccountDepreciation`; full field contract unverified | Step 4 reports `not_implemented` | **partial** |
| 15 | Depreciations | 4 | Partly | ? | ? | ? | ? | `bookkeeping` / `assets` (not verified) | Anläggningsregister + Bokföring | No dedicated depreciation endpoint verified | Official text: Fortnox products create vouchers "when bookkeeping invoices, salaries or asset depreciations" — implying depreciation is driven by the asset module, not a standalone endpoint | No standalone depreciation-run endpoint found | Propose depreciation as an ordinary voucher, or let the consultant run the asset module in Fortnox | **requires Fortnox confirmation** |
| 16 | Inbox / files | 1, 6 | Yes | Y | Y | ? | – | `archive` (not verified) | — | Archive/inbox upload as `multipart/form-data`; voucher inbox path parameter `Inbox_v` | Official file-connection guidance describes the upload and the returned `Id` | 5 GB per account. Files are never copied into this system — only referenced | `SourceDocument.externalRef` holds a reference only | **verified** |
| 17 | Voucher file connections | 6 (documentation checks) | Yes | Y | Y | ? | – | `bookkeeping` + `archive` (not verified) | Bokföring | `/3/voucherfileconnections` | `developer.fortnox.se/documentation/resources/voucher-file-connections/` exists; official text describes connecting an uploaded file to a new voucher via `Inbox_v` | Verb-level unverified | The `hasFileConnection` flag drives the missing-documentation rule; writes disabled | **verified** |
| 18 | Supplier invoice file connections | 6 | Yes | Y | ? | ? | – | `supplierinvoice` + `archive` (not verified) | Leverantörsfakturor | `/3/supplierinvoicefileconnections` | `developer.fortnox.se/documentation/resources/supplier-invoice-file-connections/` exists | Verb-level unverified | As above | **partial** |
| 19 | Cost centers | 7 (dimension checks) | Yes | Y | ? | ? | – | `costcenter` (not verified) | Bokföring | `/3/costcenters` | `developer.fortnox.se/documentation/resources/cost-centers/` exists | Verb-level unverified | Read-only; the dimension rules only validate, never create | **partial** |
| 20 | Projects | 7 (dimension checks) | Yes | Y | ? | ? | – | `project` (not verified) | Bokföring / Projekt | `/3/projects` | Official text confirms Project fields on API resources and list-view fields for Projects | No resource page URL was directly confirmed | Read-only; dimension rules validate only | **partial** |
| 21 | Salary transactions | 5 (recurring entries), payroll accruals | Yes | Y | Y | ? | – | `salary` | Lön | `/3/salarytransactions`; a holiday-debt basis endpoint takes `year` and `month` | `developer.fortnox.se/documentation/resources/salary-transactions/` exists; official blog documents the Salary scope, the holiday-debt endpoint and multiple registrations per day | Requires the payroll "Post Holiday Debt" feature for the debt endpoint | Out of scope in phase 1 | **partial** |
| 22 | SIE export | 7, 8, 9 (ledger and report data) | Yes | Y | – | – | – | `bookkeeping` (not verified) | Bokföring | `/3/sie/{type}` | `developer.fortnox.se/documentation/resources/sie/` exists | Type codes (1–4) and the response encoding were not verified | **This is the recommended fallback for report data** — see row 27 | **partial** |
| 23 | Bank transactions / *Bokföring från kontoutdrag* | 3 | **No public API found** | ? | ? | ? | ? | — | Bokföring + bankkoppling | — | Documented only on `support.fortnox.se` as an in-product feature: transactions appear under "Transaktioner" and are auto-booked on a unique match | No public resource for reading bank transactions was found | Step 3 is `not_implemented` and blocks period completion. Bank data can be imported from a bank feed or SIE outside Fortnox and reconciled read-only. **Browser automation is explicitly rejected** | **requires Fortnox confirmation** |
| 24 | Matching a bank transaction to an invoice | 3 | **No public API found** | ? | ? | ? | ? | — | — | — | `support.fortnox.se` documents matching on invoice number, reference, OCR or supplier name where amount matches the invoice balance — as a product feature | As above | As row 23 | **requires Fortnox confirmation** |
| 25 | Matching a bank transaction to a voucher | 3 | **No public API found** | ? | ? | ? | ? | — | — | — | `support.fortnox.se` documents "Matcha transaktioner" comparing date and amount on both sides — as a product feature | As above | As row 23 | **requires Fortnox confirmation** |
| 26 | Fortnox *Regelverk* (bank booking rules) | 3, 5 | **No public API found** | ? | ? | ? | ? | — | — | — | `support.fortnox.se` describes rules with parameters, limits and accounts, and a 13-rule package for the Skatteverket integration — as a product feature | Fortnox's own rules engine is not addressable over the API | This system runs **its own** deterministic rule engine (`packages/rules`) and never assumes Fortnox rules ran | **requires Fortnox confirmation** |
| 27 | *Begär underlag* (request documentation) | 12 Customer communication | **No public API found** | ? | ? | ? | ? | — | — | — | `support.fortnox.se` documents it as a side-menu action on a transaction row that notifies a user in the app | Cannot be triggered over the API | `CustomerRequest` rows are created as **drafts only** and never sent. Step 12 is `not_implemented` | **requires Fortnox confirmation** |
| 28 | Skattekonto (tax account) | 3 | **No public API found** | ? | ? | ? | ? | — | — | — | `support.fortnox.se` documents a free Skatteverket connection that reads tax-account transactions into Fortnox, with rules to book them — as a product integration | No public endpoint for tax-account transactions found. Skatteverket's own VAT-declaration API is a separate, non-Fortnox surface | Step 3 is `not_implemented` and blocks completion | **requires Fortnox confirmation** |
| 29 | General ledger / report data | 7, 8, 9 | Indirectly | Y | – | – | – | `bookkeeping` | Bokföring | Via `/3/vouchers` + `/3/accounts`, or `/3/sie/{type}` | No dedicated general-ledger endpoint was found; vouchers and accounts are documented | The ledger must be aggregated client-side | **Implemented this way**: `packages/rules` builds its own history index from vouchers. This is the fallback, and it works | **partial** |
| 30 | Balance and income reports | 9 | **No public report endpoint found** | ? | – | – | – | — | Bokföring | — | Report export is documented on `support.fortnox.se` as an in-product Excel/PDF export | No API-exposed balance sheet or income statement was verified | Compute from imported vouchers, or use SIE (row 22). Step 9 is `not_implemented` (non-blocking) | **requires Fortnox confirmation** |
| 31 | Locking a completed period | 14 Final control | Read yes, write unverified | Y | ? | ? | – | `bookkeeping` (not verified) | Bokföring | `locked-period` resource | See row 5 | **Out of scope regardless.** Locking a period is irreversible from this system's point of view | The consultant locks the period in Fortnox. The system only reports readiness | **partial** (write: **requires Fortnox confirmation**) |

---

## Summary

| Status | Count | Rows |
| --- | --- | --- |
| verified | 5 | 1, 2, 3, 16, 17 |
| partial | 18 | 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21, 22, 29, 31 |
| requires Fortnox confirmation | 8 | 15, 23, 24, 25, 26, 27, 28, 30 |
| unavailable | 0 | — |
| **Total** | **31** | |

### The gap that shapes the product

Rows 23–28 are the important ones. **The single largest lever in Swedish bookkeeping
automation — booking from bank statements, matching transactions to invoices, and the tax
account — has no verified public API.** That is not a small integration detail; it removes an
entire workflow step from automation, and step 3 is consequently `not_implemented` and
blocking.

Three honest responses exist, in order of preference:

1. **Ask Fortnox.** These may exist under partner agreement, or on the experimental API
   (`apps.fortnox.se/apidocs/experimental`). This is the first phase-2 action.
2. **Bring bank data in from the bank, not from Fortnox.** PSD2/open-banking feeds give
   transactions directly; reconciliation then happens in this system and results are proposed
   as ordinary vouchers.
3. **Leave step 3 to the human**, which is what the system does today, visibly and with a
   blocking finding rather than silence.

**Browser automation against the Fortnox web UI is explicitly rejected** as a substitute. It
would break the security model (a credential-bearing headless browser), the audit model (no
API-level evidence of what was sent), and almost certainly the terms of service.

### Re-verification checklist for phase 2

- [ ] Open every URL in the "Verified source" column with a real developer account.
- [ ] Confirm the exact `Voucher` create payload field-by-field before enabling any write.
- [ ] Confirm the real scope name for each row currently marked "(not verified)".
- [ ] Confirm whether vouchers can be updated or deleted, or only reversed.
- [ ] Confirm whether the locked period can be set via the API.
- [ ] Ask Fortnox directly about rows 23–28.
- [ ] Check `apps.fortnox.se/apidocs/experimental` for bank-transaction resources.
