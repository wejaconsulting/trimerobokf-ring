# Shadow mode

The system ships in **strict shadow mode**. This document states exactly what that means, how
it is enforced, how it is tested, and - now that the whole path to live booking is built - the
exact sequence of switches that lifts it. The Swedish, consultant-facing version of the same
ladder is in [`autonomi.md`](./autonomi.md).

## What the system may do in shadow mode

- Read accounting data - through the **mock adapter** (`FORTNOX_ADAPTER=mock`) or, for a client
  with a live OAuth grant, **read-only from Fortnox** (`FORTNOX_ADAPTER=auto|real`).
- Analyse the books with the deterministic rule engine.
- Create booking proposals.
- Create findings and review items.
- **Simulate** a Fortnox call and show the exact payload that would be sent.
- Record a consultant's review decision as internal state, bound to the payload's hash.
- Record the system's own approval of an `automatic`-level proposal when the client's policy
  allows it (`autoBookEnabled`) - also internal state, also bound to the hash.

## What the system must not do in shadow mode — and cannot

| Prohibited | Why it cannot happen |
| --- | --- |
| Write to a real Fortnox account | `evaluateWriteGate` fails on `shadow_mode_active` before anything else is checked. `RealFortnoxAdapter` refuses to be *constructed* write-enabled under shadow mode. `appConfigFromEnv` refuses `FORTNOX_WRITES_ENABLED=true` with `SHADOW_MODE=true`. The per-client write switch cannot be turned on while shadow mode is active (HTTP 409). |
| Book in production | Every submission - the `human_review` step, the decision route, `POST /api/close-runs/:id/submit` - goes through `submitApprovedProposals`, which asks the gate per proposal. |
| Lock a period | `lockPeriod` throws in every adapter, with or without an approved context. Locking is out of scope. |
| Send customer email | `CustomerRequest` rows are created with `status: 'draft'` and `sentAt: null`. No mail client exists in the dependency graph. |
| Use browser automation to book in Fortnox | No browser dependency exists. Explicitly rejected in the capability matrix. |
| Give a language model access to a token or credential | The model receives a hand-built object of counts, amounts and rationales. It has no database handle, no adapter, and a two-entry read-only tool allowlist. Tokens live in `FortnoxHttpClient`, sealed at rest. |

## How the write gate works

The gate is deliberately **not** a single flag. `evaluateWriteGate` in
`packages/fortnox/src/write-policy.ts` requires **all** of:

```
1. shadowMode                    === false     (SHADOW_MODE)
2. featureFlagEnabled            === true      (FORTNOX_WRITES_ENABLED + acknowledgement phrase)
3. policy.clientWritesEnabled    === true      (per client, an audited switch in the console)
4. approvalDecisionId            !== null      (a recorded decision - human, or system by policy)
5. approvedPayloadHash           === payloadHash  (that decision approved THESE bytes)
6. policy.periodOpen             === true      (locked period read fresh at submission time)
7. policy.validationsPassed      === true      (the voucher balances)
```

Condition 5 is the one that matters most. A decision is bound to a hash of the exact payload.
If the proposal is edited afterwards - any field - the hash changes and the gate returns
`payload_changed_since_approval`. An approval cannot be silently reused for different bytes.

Two further guarantees sit around the gate:

- **Once, ever.** Before posting, the proposal is *claimed* with a compare-and-set from
  `approved_shadow` to `submitting`, so two submitters cannot both post it. After posting, the
  payload hash is recorded as a processed source key; a re-run of the period shows the same
  correction as `already_booked` instead of proposing it again.
- **Only creates.** The only write transport is `POST /3/vouchers`. Nothing updates, deletes
  or locks.

Defence in depth beyond the gate:

- `appConfigFromEnv` refuses to start with `FORTNOX_WRITES_ENABLED=true` unless `SHADOW_MODE=false`,
  `FORTNOX_WRITES_ACKNOWLEDGEMENT` equals the exact phrase, and `FORTNOX_ADAPTER` is not `mock`.
- The data-source resolver only builds a write-enabled adapter when the configuration passed
  those checks **and** the client's own connection row has `writesEnabled`.
- The readiness step blocks the run if the client's connection has `writesEnabled` while shadow
  mode is on.
- The safety switches parse with a safe default: an unrecognised `SHADOW_MODE` value leaves
  shadow mode **on**.

## What the consultant sees

Every booking proposal shows:

- the debit/credit rows, with cost center, project and VAT code,
- the endpoint (`POST /3/vouchers`),
- the complete JSON body, verbatim,
- the payload hash, and on every decision the hash it was bound to,
- its status: simulated, approved (not booked), booked in Fortnox with the voucher reference,
  already booked, or failed.

The chip in the console's sidebar reports the live posture from `/api/system/status`: **SHADOW
MODE** (nothing is sent), **LÄSLÄGE** (shadow mode off, write flag off) or **LIVE-BOKFÖRING**.

## Verification

Shadow mode is asserted, not assumed:

| Assertion | Where |
| --- | --- |
| The gate blocks on every single failing condition | `packages/fortnox/src/write-policy.test.ts` |
| The real adapter never posts read-only, without a context, or with a failing gate | `packages/fortnox/src/real-adapter.test.ts` |
| The real adapter refuses write-enabled construction under shadow mode | same file |
| A close run through the real adapter against a Fortnox-shaped API posts nothing in shadow mode, and every approved proposal is reported blocked with `shadow_mode_active` | `packages/workflow/test/autonomy.itest.ts` |
| With every switch on, exactly the approved bytes are posted once; a re-run books nothing; an edited payload and a client switched off are refused | same file |
| No audit event carries a Fortnox id in shadow mode | `packages/workflow/test/close-run.itest.ts`, `apps/api/test/api.itest.ts`, `scripts/smoke.ts` |
| The server refuses a write-enabled configuration that is missing any condition | `apps/api/test/deploy-config.itest.ts` |
| The per-client switch is refused under shadow mode | `apps/api/test/firm.itest.ts` |
| The end-to-end flow, including firm operations, holds shadow mode | `scripts/smoke.ts` — 44 checks |

## Lifting shadow mode

Everything below is implemented and tested. None of the steps may be skipped, and each one on
its own does nothing until the ones before it are in place.

1. **Connect the client** (console → Fortnox-anslutning). Read scopes only.
2. **`FORTNOX_ADAPTER=auto`** (or `real`). Runs now read the connected client's books. Still
   shadow mode. Run at least one full period and read the proposals.
3. **`autoBookEnabled`** on the client's policy (console → klientens inställningar). The system
   records its own approvals of `automatic`-level proposals. Still nothing is sent.
4. **`SHADOW_MODE=false`**. Condition 1.
5. **`FORTNOX_WRITES_ENABLED=true`** with
   `FORTNOX_WRITES_ACKNOWLEDGEMENT=JAG FÖRSTÅR ATT DETTA BOKFÖR PÅ RIKTIGT I KLIENTERNAS FORTNOX`.
   Condition 2. The API refuses to start if any part is missing.
6. **Per-client write switch** on the Fortnox settings page. Condition 3. Audited.

Recommended: enable step 6 for **one** pilot client first, watch the `fortnox.write_submitted`
audit events and the voucher references in the console, and only then widen. There is no
"book everything" switch anywhere; each proposal is still gated individually.

What is still deliberately out of scope: updating or deleting vouchers, locking periods, sending
customer email, and any workflow step whose Fortnox capability has no verified public API.
