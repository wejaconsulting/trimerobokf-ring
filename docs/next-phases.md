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

### 2.2 Implement the real adapter's read path — **done**

- OAuth2 with sealed tokens and serialised refresh: `packages/fortnox/src/oauth/`.
- Rate limit 25 / 5 s as a sliding window with back-off on 429: `packages/fortnox/src/http/`.
- Response mapping into `LedgerSnapshot` shapes, validated with zod at the boundary:
  `packages/fortnox/src/wire.ts`.
- Contract tests against a Fortnox-shaped fake (`packages/testing/src/fake-fortnox.ts`) and a
  full close run through it (`packages/workflow/test/autonomy.itest.ts`).
- [ ] Still to do: run it against a **sandbox** account and compare with the fake. The wire
      shapes come from the published OpenAPI specification, not from a live call.

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

## Phase 4 — Lift shadow mode, carefully — **built, not switched on**

The write path exists end to end: approvals bound to payload hashes, policy-driven system
approvals, the seven-condition gate, `POST /3/vouchers`, the per-client switch, the
once-only guard. [`shadow-mode.md`](./shadow-mode.md) lists the switches in order.

What remains is operational, not code:

1. Run a full period in shadow mode against a real account and have a consultant read the
   automatically approved proposals.
2. Enable the per-client switch for **one** pilot client.
3. [ ] Read back and reconcile every write against Fortnox (fetch the created voucher and
       compare rows); alert on divergence. Today the created voucher's reference is stored;
       the read-back is not automated.
4. Expand one client at a time.

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
