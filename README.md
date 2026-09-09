# Trimeros Accounting Agent

An AI-assisted agent for ongoing bookkeeping and month-end reconciliation against **Fortnox**,
built for Swedish accounting consultants.

The goal is to move the consultant from *"go through and book everything"* to
**"review and handle the exceptions."**

> ## ⚠️ Phase 1 is strictly shadow mode
>
> This system **reads** synthetic data through a mock adapter, analyses it, produces booking
> proposals and shows the exact Fortnox payload that *would* be sent — and **never sends it**.
> There is no code path from any endpoint to a Fortnox write. See
> [`docs/shadow-mode.md`](docs/shadow-mode.md).

---

## Quick start

Requires **Node ≥ 22.12** and **pnpm 10**. Docker is optional.

```bash
pnpm install                # 1. install
cp .env.example .env        # 2. configure (defaults work as-is; no secrets needed)
pnpm db:migrate             # 3. create the database (PGlite — no Docker required)
pnpm db:seed                # 4. seed the demo firm and client
pnpm demo:close-run         # 5. run a synthetic close run and print the result
pnpm dev                    # 6. start the API (:4000) and the review app (:3000)
```

Then open <http://localhost:3000>.

No API keys are required. No Fortnox account is required. Nothing leaves your machine.

---

## Commands

### Install and configure

```bash
pnpm install                       # install all workspace dependencies
cp .env.example .env               # every secret field is empty by design
```

### Database

The database layer runs on one dialect (PostgreSQL) with two drivers.

**Default — PGlite (Postgres in-process, no Docker):**

```bash
pnpm db:migrate                    # apply migrations to .pglite/dev
pnpm db:seed                       # seed the demo tenant (idempotent)
pnpm db:reset                      # drop everything and re-migrate
```

**With Docker — a real Postgres 17 server:**

```bash
pnpm db:up                         # start postgres on localhost:5433
# set DB_DRIVER=postgres in .env, then:
pnpm db:migrate
pnpm db:seed
pnpm db:down                       # stop it
```

Both drivers apply the same generated migrations, so they cannot drift.

```bash
pnpm db:generate                   # regenerate SQL after changing the Drizzle schema
```

### Development

```bash
pnpm dev                           # API on :4000 and review app on :3000
pnpm dev:api                       # API only
pnpm dev:web                       # review app only
pnpm demo:close-run                # run one synthetic close run and print the steps
pnpm demo:close-run 2025-07        # ...for a different period
```

### Tests and checks

```bash
pnpm test                          # all tests (unit + integration)
pnpm test:unit                     # unit tests only — fast, no database
pnpm test:integration              # integration tests against real Postgres SQL via PGlite
pnpm typecheck                     # tsc across every package and the web app
pnpm lint                          # eslint across the monorepo
pnpm smoke                         # end-to-end smoke test of the main flow
pnpm verify                        # lint + typecheck + test + smoke
```

### Build

```bash
pnpm build                         # production build of the review app
```

---

## What a close run does

Running `pnpm demo:close-run` executes all 14 workflow steps for the demo client's 2025-08
period:

```
agent_readiness                    completed        24 accounts, 15 vouchers in the period, 120 in history
customer_and_supplier_invoices     not_implemented  phase 1 scope — blocks completion
bank_and_tax_account_transactions  not_implemented  no verified public Fortnox API — blocks completion
accruals_and_depreciations         not_implemented  blocks completion
recurring_journal_entries          not_implemented  blocks completion
completeness_check                 completed        5 observations
general_ledger_review              completed        12 observations
balance_reconciliations            not_implemented  blocks completion
income_statement_analysis          not_implemented  does not block
consolidate_findings               completed        22 observations → 20 findings (2 merged), 2 simulated calls
accountant_report                  completed        8 blocking findings remain
customer_communication_draft       not_implemented  does not block
human_review                       blocked          20 findings awaiting a decision
final_control                      blocked          the period is NOT complete, and here is why
```

The point of the last line: **the system refuses to report the period complete**, and says
exactly which steps and findings are in the way. An unimplemented step that carries real
accounting work blocks completion rather than being quietly skipped.

---

## The review app

Four desktop-first views:

| View | Shows |
| --- | --- |
| **Firm overview** (`/`) | Automation rate across the firm, data sources, approved and booked proposals; run a period for every client; add a client. Per client: period, data source, close-run status, completed steps, and counts for clear / review / missing documentation / findings / blockers. |
| **Client settings** (`/klienter/:id`) | The accounting policy in kronor (materiality, automation limit, history window, dimension requirements) and the `autoBookEnabled` switch that lets the system approve `automatic`-level proposals itself. |
| **Fortnox connection** (`/installningar/fortnox`) | Connect a client's Fortnox over OAuth (read scopes only), verify, disconnect, and the audited per-client write switch. |
| **Period view** (`/runs/:id`) | All 14 workflow steps with status: pending, running, completed, blocked, not implemented, failed. The data source the run read from, proposal counts (approved / booked / already booked), the "book approved proposals" action, and the explicit reasons the period cannot close. |
| **Review queue** (`/runs/:id/queue`) | Filter by clear, review, missing documentation, anomaly, blocking, amount range, account, supplier and decision score. |
| **Finding detail** (`/findings/:id`) | What was detected, the original data, the evidence, the historical comparison, the matched rules, the booking proposal with debit/credit, VAT and dimensions, **the simulated Fortnox payload**, the audit history, and the actions: approve, reject, edit proposal, request information. |

**Approve changes internal review status only. It does not write to Fortnox.**

---

## The synthetic client

`Nordvik Konsult AB` (556677-8899) is entirely fictional: 13 months of Swedish bookkeeping
(2024-08 → 2025-08), ~135 vouchers on the BAS chart of accounts, with recurring rent, a SaaS
subscription, bank charges, telecom, cleaning, customer invoices, payments, VAT, cost centers,
projects and monthly depreciation.

The current period seeds ten deliberate exceptions: a missing receipt (with input VAT claimed
anyway), one invoice booked twice, a 4× amount deviation, a brand-new supplier with no
history, a wrong VAT code, an invoice booked two months late, a large manual A-voucher on a
rarely used account, a cost posted to a balance account where history uses a result account, a
row missing its required cost center, and — the rent — a recurring monthly cost that is simply
absent.

The result is a demo where some items are clear, some need review, and some block the period.

---

## Architecture at a glance

```
apps/web       Next.js review console (server components; no client-side API access)
apps/api       Fastify HTTP API + the composition root

packages/domain     entities, state machine, decision model, finding consolidation, audit redaction
packages/fortnox    ports, endpoint registry, write gate, mock adapter, real adapter (disabled)
packages/rules      11 mandatory validations + 10 anomaly rules + proposal generator (pure)
packages/agent      ModelProvider interface, fake provider, OpenAI provider, versioned prompts
packages/workflow   the 14-step engine, step handlers, audit writer, review recorder
packages/db         Drizzle schema, migrations, dual-driver client, repositories, seed
packages/testing    the synthetic Swedish client
```

Full detail, trust boundaries and the Temporal decision: [`docs/architecture.md`](docs/architecture.md).

---

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Data flow, trust boundaries, who is responsible for what, why not Temporal yet. |
| [`docs/fortnox-capability-matrix.md`](docs/fortnox-capability-matrix.md) | 31 capabilities verified against official Fortnox documentation, with limitations, fallbacks and status. **Read the verification-method section first.** |
| [`docs/security-and-permissions.md`](docs/security-and-permissions.md) | Tenant isolation, secrets, the audit log, the model boundary, and the known gaps. |
| [`docs/accounting-decision-model.md`](docs/accounting-decision-model.md) | The three levels, the ten signals and their weights, the validations, the anomaly rules, deduplication. |
| [`docs/shadow-mode.md`](docs/shadow-mode.md) | What is forbidden, how it is enforced, how it is tested, and the exact sequence of switches that lifts it. |
| [`docs/autonomi.md`](docs/autonomi.md) | *På svenska.* Hur systemet tar över rutinarbetet, brytarna i ordning, skrivgrindens sju villkor och vad som aldrig händer. |
| [`docs/next-phases.md`](docs/next-phases.md) | What to build next, in dependency order. |
| [`docs/deployment.md`](docs/deployment.md) | Hosting on Render or Railway, the password gate, and what was and was not verified. |
| [`docs/fortnox-oauth.md`](docs/fortnox-oauth.md) | Connecting a client's Fortnox account over OAuth: setup, the read-only boundary, token handling, and which details are still unverified. |

---

## Configuration

All settings live in `.env` (see `.env.example`). The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `DB_DRIVER` | `pglite` | `pglite` (no Docker) or `postgres` |
| `PGLITE_DATA_DIR` | `.pglite/dev` | Ignored when using `postgres` |
| `DATABASE_URL` | `postgres://trimeros:trimeros@localhost:5433/trimeros` | Matches `docker-compose.yml` |
| `API_PORT` | `4000` | |
| `API_BASE_URL` | `http://127.0.0.1:4000` | Used by the review app |
| `SHADOW_MODE` | `true` | Nothing is sent to Fortnox while true. Parsed safely: an unrecognised value keeps it on. |
| `FORTNOX_WRITES_ENABLED` | `false` | Needs `SHADOW_MODE=false`, the `FORTNOX_WRITES_ACKNOWLEDGEMENT` phrase and a non-mock adapter, or the API refuses to start. See [`docs/shadow-mode.md`](docs/shadow-mode.md). |
| `FORTNOX_ADAPTER` | `mock` | `mock` (demo data), `auto` (Fortnox for connected clients, demo data for the rest) or `real` (Fortnox only). |
| `MODEL_PROVIDER` | `fake` | `fake` is deterministic and offline. `openai` needs `OPENAI_API_KEY`; without one it falls back to `fake` rather than failing a run. |

No secrets are committed. `.env` is git-ignored and every secret field in `.env.example` is
empty.

---

## Licence

Proprietary — internal project.
