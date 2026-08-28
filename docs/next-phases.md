# Next phases

Ordered by what blocks what, not by what is interesting.

---

## Phase 2 — Make it safe to point at a real Fortnox account (read-only)

Nothing else should start before this. The goal is a **read-only** run against a real client's
books, still in shadow mode.

### 2.1 Re-verify the Fortnox contract *(blocks everything else)*

The capability matrix was compiled from official documentation surfaced through search,
because `fortnox.se` was unreachable from the build environment. Every row needs a human with
a developer account to open the page and confirm it. Specifically:

- [ ] The `Voucher` create payload, field by field. This is the one that must be exactly right.
- [ ] Real scope names for every row currently marked "(not verified)".
- [ ] Whether vouchers can be updated or deleted, or only reversed.
- [ ] Whether the locked period can be set via the API.
- [ ] **Ask Fortnox directly about rows 23–28** (bank transactions, matching, Regelverk, begär
      underlag, skattekonto). These may exist under a partner agreement or on the experimental
      API. Their absence is the single biggest constraint on the product.

### 2.2 Implement the real adapter's read path

- OAuth2 with the token in a secret manager, refreshed on a schedule (access token 1 h,
  refresh token 45 days, and a used refresh token is invalidated — so refresh must be
  serialised per connection or a race will lock the integration out).
- Respect the rate limit: 25 requests / 5 s per token. A token-bucket limiter with
  backpressure, not retry-on-429.
- Response mapping into the existing `LedgerSnapshot` shapes, validated with zod at the
  boundary — parse, don't assume.
- Contract tests against recorded fixtures from a **sandbox** account.

### 2.3 Close the security gaps

From [`security-and-permissions.md`](./security-and-permissions.md):

- [ ] Authentication (OIDC), with the tenant derived from the session, never from a header.
- [ ] Enforce the four roles.
- [ ] Postgres row-level security, so a repository bug cannot leak across tenants.
- [ ] Rate limiting; a real CORS allowlist.
- [ ] A production `AccessTokenProvider` backed by a secret manager.

### 2.4 Production build

Replace `tsx` at runtime with a bundle per app (`tsup` or `esbuild`), a Dockerfile per app,
and a migration step in the deploy pipeline. Small and mechanical; see "Build strategy" in
[`architecture.md`](./architecture.md).

---

## Phase 3 — Complete the workflow

Implement the steps currently reporting `not_implemented`, in the order their value justifies.

| Step | What it needs | Blocked by |
| --- | --- | --- |
| 2 Customer & supplier invoices | Reconcile sub-ledgers to the general ledger; propose bookings for unbooked invoices | 2.1, 2.2 |
| 4 Accruals & depreciations | Accrual and asset endpoints; a depreciation schedule model | 2.1 (rows 12–15) |
| 5 Recurring journal entries | A recurring-entry rule kind and a schedule | — |
| 8 Balance reconciliations | Sub-ledger balances and external statements | 2.2 |
| 9 Income-statement analysis | Budget import and period-over-period comparison | — |
| 3 Bank & tax-account transactions | **Depends on the answer to 2.1.** If no API exists, source bank data from an open-banking feed instead and reconcile here | 2.1 |
| 12 Customer communication | A mail integration, plus a human-approval gate on send | 2.3 |

Step 3 is the one to decide early, because the answer changes the architecture: either Fortnox
is the bank-data source, or the system needs its own bank connection.

---

## Phase 4 — Lift shadow mode, carefully

Follow the ordered list in [`shadow-mode.md`](./shadow-mode.md). The shape:

1. Wire `approvalDecisionId` + `approvedPayloadHash` from the review UI into the write gate.
2. Enable writes for **one** proposal type (the dimension reclassification — smallest blast
   radius, fully deterministic) for **one** pilot client, behind a per-client flag and a kill
   switch.
3. Read back and reconcile every write against Fortnox; alert on any divergence.
4. Expand one proposal type at a time, never one client at a time.

Do not start until a full period has run in shadow mode against a real account and a
consultant has reviewed the proposals and agreed with them.

---

## Phase 5 — Durable workflow

Swap `DatabaseWorkflowEngine` for a Temporal implementation behind the existing
`WorkflowEngine` interface. The step handlers are already engine-agnostic and idempotent, so
this is genuinely a swap.

Trigger: when a step becomes long-running (a large SIE import, a real Fortnox sync across the
rate limit), or when human review needs to suspend a workflow for days rather than be modelled
as a blocked step. Not before — see the rationale in [`architecture.md`](./architecture.md).

---

## Phase 6 — Make the rules learn (carefully)

The current rules are hand-written and deterministic, which is why they are explainable. The
next increment is **not** to replace them with a model. It is:

- **Rule mining**: propose new client rules from history (this supplier is always coded 6540
  with cost center ADM) and let a consultant accept them. The accepted rule is deterministic;
  only the *suggestion* is statistical.
- **Threshold tuning per client**: learn the amount-deviation threshold from the client's own
  variance instead of a fixed 0.5.
- **Feedback loop**: every approve/reject is already recorded. Use rejection rates per rule to
  find rules that cry wolf, and report them rather than silently suppressing them.

Explicitly **not** planned: letting a model decide a decision level, letting it bypass the rule
engine, or replacing the deterministic validations. Those are load-bearing.

---

## Smaller things worth doing

- **Reconciliation entities are modelled but unused.** `Reconciliation` /
  `ReconciliationItem` exist in the schema and are populated by nothing until step 8.
- **`ClientRule` kinds** `vat_code_for_account` and `ignore_account` are seeded and stored but
  not yet consumed by any rule.
- **Web app tests.** The API and the domain are well covered; the UI has none. A few Playwright
  smoke paths (Chromium is already available) would cover the four views.
- **Structured logging** with the correlation id on every request, so an audit trail can be
  joined to application logs.
- **`bankTransactions`** are imported and stored but no rule consumes them, pending step 3.
- **Observability**: metrics for close-run duration, findings per run, and the ratio of
  automatic to review to manual — that ratio is the product's core KPI.
