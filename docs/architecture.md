# Architecture

## What this system is

An AI-assisted accounting agent for Swedish bookkeeping consultants. It analyses a client's
books in Fortnox for one period, decides what is routine and what is not, and hands the
consultant a short queue of exceptions instead of a full ledger to read.

The product thesis in one line: **move the consultant from "go through and book everything"
to "review and handle the exceptions."**

Phase 1 is the vertical slice that proves the shape: import → analyse → decide → queue →
report, with every write to Fortnox disabled.

---

## Non-negotiables

1. **Fortnox is the source of truth.** This system's database holds operational state,
   normalised copies for analysis, client rules, findings, review decisions and audit logs.
   It never holds the authoritative books.
2. **Determinism decides; the model explains.** Every finding, every decision level and every
   proposal comes from explainable code. A language model phrases the summary. It cannot
   change a number, a level or a status.
3. **Shadow mode is enforced by construction, not by discipline.** See
   [`shadow-mode.md`](./shadow-mode.md).
4. **A period is never reported complete because the system did not look.** Unimplemented
   steps that carry accounting work block completion and raise a visible blocking finding.

---

## Data flow

```
                    ┌──────────────────────────────────────────────┐
                    │  FORTNOX  (source of truth — never written)  │
                    │  vouchers · accounts · invoices · locks      │
                    └───────────────────┬──────────────────────────┘
                                        │  read only
                        ┌───────────────▼────────────────┐
                        │  FortnoxReadPort               │   ← trust boundary 1
                        │  MockFortnoxAdapter (phase 1)  │
                        │  RealFortnoxAdapter (disabled) │
                        └───────────────┬────────────────┘
                                        │ normalised LedgerSnapshot
        ┌───────────────────────────────▼──────────────────────────────┐
        │  WORKFLOW ENGINE  (14-step state machine, DB-backed)          │
        │                                                               │
        │   1 readiness ──► import ──► 6 completeness ──► 7 GL review    │
        │        │                          │                  │        │
        │        │                          └────────┬─────────┘        │
        │        │                                   ▼                  │
        │        │                     10 consolidate + dedupe          │
        │        │                                   │                  │
        │        │                    ┌──────────────┼────────────┐     │
        │        │                    ▼              ▼            ▼     │
        │        │              proposals      review queue   11 report │
        │        │           (simulated only)                     │     │
        │        └─────────────────────────────────────────────┐  │     │
        │        13 human review ──► 14 final control ◄────────┘  │     │
        └──────────┬───────────────────────┬─────────────────────┬┘     │
                   │                       │                     │
        ┌──────────▼─────────┐  ┌──────────▼────────┐  ┌─────────▼────────────┐
        │  RULES ENGINE      │  │  POSTGRES         │  │  MODEL PROVIDER      │
        │  pure functions    │  │  operational      │  │  fake | openai       │
        │  no I/O, no model  │  │  state + audit    │  │  ← trust boundary 2  │
        └────────────────────┘  └───────────────────┘  └──────────────────────┘
                                        │
                             ┌──────────▼──────────┐
                             │  REVIEW APP (web)   │  ← trust boundary 3
                             │  consultant decides │
                             └─────────────────────┘
```

### Trust boundaries

| # | Boundary | What crosses it | What must never cross it |
| --- | --- | --- | --- |
| 1 | **Fortnox ↔ system** | Reads only. Normalised ledger copies in. | Any write. Any lock. Any customer email. Enforced by `evaluateWriteGate` + the adapter factory. |
| 2 | **System ↔ language model** | Counts, amounts, rule rationales, step labels — a bounded, hand-built object. | OAuth tokens, API keys, database handles, Fortnox adapters, raw documents, personal data. The model has no tool that reaches any of these. |
| 3 | **System ↔ consultant** | Findings, evidence, proposals, the exact simulated payload. | Nothing is hidden: the payload that *would* be sent is shown verbatim. |
| 4 | **Tenant ↔ tenant** | Nothing. Every table carries `tenantId`; every repository method takes a tenant scope as its first argument. | Cross-tenant reads. Verified by an integration test. |

---

## Responsibility split

This is the part worth arguing about, so it is written down explicitly.

| Concern | Owner | Why |
| --- | --- | --- |
| What the books actually say | **Fortnox** | It is the system of record and the legal archive. |
| What documents exist | **Fortnox** (archive/inbox) | Copying documents here would create a second archive to secure and to keep in sync. This system stores references only. |
| Which steps run, in what order, and what state they are in | **Workflow engine** | One place to answer "how far did we get and why did we stop". |
| Whether something is an anomaly | **Rules engine** | Deterministic, versioned, testable and explainable to a consultant and, ultimately, to an auditor. |
| How confident we are | **Decision model** | A weighted score over observable signals plus hard gates. Explicitly *not* the model's self-reported confidence. |
| What the correction should be | **Rules engine** (proposal generator) | Proposals are derived from client rules, not generated prose. |
| How to phrase the summary | **Language model** | The one thing a model is genuinely better at than code. |
| Whether to accept a proposal | **The consultant** | Always. There is no autonomous booking path in phase 1, and the write gate requires a recorded human approval bound to a payload hash even in later phases. |

### What the language model may and may not do

May: summarise already-decided results, phrase a customer-request draft, explain a finding in
prose.

May not: change an amount, a decision level, a severity or a status; call Fortnox; touch the
database; execute a tool; or declare a period complete. Its prompt says so, its tool
allowlist contains two read-only lookups, and — decisively — **no code path exists from a
model response to a state change.** Its output lands in a report field.

---

## Package layout

The suggested structure was followed, with two documented additions.

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `packages/domain` | Entities, enums, money, periods, the 14-step definition, the state machine, the decision model, finding consolidation, audit redaction. Pure, no I/O. | zod |
| `packages/fortnox` | Ports, endpoint registry, write gate, payload builder, mock adapter, real adapter (disabled). | domain |
| `packages/rules` | Mandatory validations, anomaly rules, history index, proposal generator. Pure functions over a `RuleContext`. | domain |
| `packages/agent` | `ModelProvider` interface, fake provider, OpenAI provider, versioned prompts, tool allowlist, retry policy. | domain |
| `packages/db` | Drizzle schema, migrations, dual-driver client, repositories, seed. | domain, testing |
| `packages/testing` | The synthetic Swedish client and its accounting policy. | domain |
| **`packages/workflow`** | **Added.** The engine, step handlers, audit writer, review recorder. | all of the above |
| `apps/api` | Fastify HTTP surface + composition root. | all |
| `apps/web` | Next.js review console. | domain |

### Addition 1 — `packages/workflow`

The suggested layout had no home for the engine. Putting it in `apps/api` would have made the
engine an HTTP concern and made it untestable without a server; putting it in `packages/rules`
would have given the pure rule functions a database dependency. A separate package keeps
`rules` pure (its tests need no database) and lets the engine be swapped — which is the whole
point of the next section.

### Addition 2 — `packages/testing` is a runtime dependency of `apps/api`

The mock adapter needs a dataset, and in phase 1 that dataset *is* the Fortnox account. This
is deliberate and temporary: when the real adapter is wired up, `apps/api` drops the
dependency and `packages/testing` returns to being test-only.

---

## Workflow engine: why not Temporal yet

**Decision: ship a database-backed state machine behind a `WorkflowEngine` interface. Do not
introduce Temporal in phase 1.**

Temporal is the right answer for this problem *eventually*. A month-end close is long-running,
partially human-driven, and needs durable retries — exactly what it is for.

It is the wrong answer *now*:

- It adds a server, a worker process and a second deployment topology to a phase whose goal is
  to prove the domain model is right.
- A phase-1 close run is a single pass over ~15 vouchers that completes in under a second.
  There is no durability problem to solve yet.
- The genuinely hard part of adopting Temporal later is not the SDK — it is having activities
  that are idempotent and side-effect-free enough to be replayed. That work has been done
  here regardless: every step is idempotent, imports upsert on a natural key, findings upsert
  on `(tenant, run, deduplicationKey)`, and processed source keys are recorded so a re-run
  cannot double-book. The integration test asserts that a second `executeCloseRun` produces
  identical results.

What makes the swap contained:

```ts
export interface WorkflowEngine {
  startCloseRun(input: StartCloseRunInput): Promise<{ closeRunId: string }>;
  executeCloseRun(tenantId: string, closeRunId: string): Promise<CloseRunSummary>;
  getSummary(tenantId: string, closeRunId: string): Promise<CloseRunSummary>;
}
```

`DatabaseWorkflowEngine` implements it. A `TemporalWorkflowEngine` would implement the same
interface with the **step handlers unchanged** — they are already plain
`(ctx) => Promise<StepOutcome>` functions with no engine coupling. The legal transitions live
in `packages/domain/src/state-machine.ts` as pure functions, so they are shared by both.

The trigger to adopt Temporal: when a step becomes genuinely long-running (a large SIE import,
a real Fortnox sync across a rate limit) or when human review needs to suspend a workflow for
days rather than be modelled as a blocked step.

---

## Build strategy

Workspace packages are consumed as **TypeScript source** (`"exports": "./src/index.ts"`)
rather than as built JavaScript. The API runs under `tsx`; Next.js transpiles `@trimeros/domain`
via `transpilePackages`; Vitest and `tsc` read the source directly.

The trade-off, stated plainly: there is **no production bundle** yet. `pnpm start:api` runs
under `tsx`, which is fine for a phase-1 demo and not fine for production. Adding `tsup` or
`esbuild` per package is a small, mechanical change and is listed in
[`next-phases.md`](./next-phases.md). It was left out deliberately: build plumbing would have
cost more than it proved at this stage.

---

## Database

PostgreSQL via Drizzle, one dialect, two drivers:

- **`postgres`** — the Docker Compose instance, and the shape production uses.
- **`pglite`** — Postgres compiled to WASM, running in-process.

The same generated migrations apply to both, so the paths cannot drift. PGlite is the default
because it means `pnpm test` and `pnpm smoke` work on a laptop or in CI with no Docker daemon —
and the environment this repository was built in had no usable Docker daemon, so the
integration tests here run against PGlite and genuinely exercise Postgres SQL.

Money is stored as **integer öre** in `numeric(20,0)`. Kronor are never used for arithmetic:
in a system whose central assertion is that debit equals credit, floating-point drift is not
an acceptable risk. Conversion to decimal kronor happens in exactly one place — the Fortnox
payload builder — because that is what the wire format expects.

---

## Idempotency

Re-running a close run must be safe. Four mechanisms together make it so:

| Mechanism | Where |
| --- | --- |
| Imports upsert on `(tenant, client, kind, externalId)` | `imported_records` unique index |
| Findings upsert on `(tenant, closeRun, deduplicationKey)` | `findings` unique index |
| Steps carry an `idempotencyKey` unique per tenant | `close_run_steps` |
| Booked source records are recorded and checked | `processed_source_records` + the duplicate-source-record validation |

Asserted by an integration test that runs the same close run twice and compares the results.

---

## Key files to read

| File | Why it matters |
| --- | --- |
| `packages/domain/src/decision.ts` | The decision model: gates, weights, and why confidence is absent. |
| `packages/domain/src/state-machine.ts` | The completion gate — the rule that stops false "period complete". |
| `packages/domain/src/findings.ts` | Deduplication: the reason two checks produce one queue item. |
| `packages/fortnox/src/write-policy.ts` | The three-condition write gate. |
| `packages/rules/src/anomalies.ts` | The ten anomaly rules, each with its own explanation. |
| `packages/workflow/src/engine.ts` | The 14-step table and the transition loop. |
| `packages/db/src/schema/index.ts` | Tenant isolation and the uniqueness constraints behind idempotency. |
