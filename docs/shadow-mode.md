# Shadow mode

Phase 1 is **strictly shadow mode**. This document states exactly what that means, how it is
enforced, and what would have to change to lift it.

## What the system may do

- Read accounting data through the **mock adapter**.
- Analyse the books with the deterministic rule engine.
- Create booking proposals.
- Create findings and review items.
- **Simulate** a Fortnox call and show the exact payload that would be sent.
- Record a consultant's review decision as internal state.

## What the system must not do — and cannot

| Prohibited | Why it cannot happen |
| --- | --- |
| Write to a real Fortnox account | `createFortnoxAdapter` throws if `adapter: 'real'` while `shadowMode` is true. `appConfigFromEnv` throws if `FORTNOX_ADAPTER=real`. Both adapters' write methods throw. |
| Use real client data | The only adapter wired up serves `buildSyntheticDataset()`. No credential is read, because none is needed. |
| Book in production | There is no code path from any HTTP endpoint to a Fortnox write. |
| Lock a period | `lockPeriod` throws in both adapters. `FORTNOX_ALLOW_PERIOD_LOCK` is documented but unused — locking is out of scope entirely. |
| Send customer email | `CustomerRequest` rows are created with `status: 'draft'` and `sentAt: null`. No mail client exists in the dependency graph. |
| Use browser automation to book in Fortnox | No browser dependency exists. Explicitly rejected in the capability matrix. |
| Give a language model access to a token or credential | The model receives a hand-built object of counts, amounts and rationales. It has no database handle, no adapter, and a two-entry read-only tool allowlist. |

## How the write gate works

The gate is deliberately **not** a single flag. `evaluateWriteGate` in
`packages/fortnox/src/write-policy.ts` requires **all** of:

```
1. shadowMode                    === false     (global switch)
2. featureFlagEnabled            === true      (FORTNOX_WRITES_ENABLED)
3. policy.clientWritesEnabled    === true      (per-client, stored in the database)
4. approvalDecisionId            !== null      (a recorded human decision exists)
5. approvedPayloadHash           === payloadHash  (that human approved THESE bytes)
6. policy.periodOpen             === true
7. policy.validationsPassed      === true
```

Condition 5 is the one that matters most. A human approval is bound to a hash of the exact
payload. If the proposal is regenerated and any field changes, the hash changes and the gate
returns `payload_changed_since_approval`. An approval cannot be silently reused for different
bytes.

Defence in depth beyond the gate:

- `RealFortnoxAdapter`'s **constructor** throws if asked to be write-enabled while shadow mode
  is on. A misconfigured adapter cannot even be built.
- `appConfigFromEnv` refuses to start the API with `FORTNOX_WRITES_ENABLED=true` at all in
  phase 1, with an error pointing at this document.
- The readiness step blocks the run if the client's stored integration connection has
  `writesEnabled` set.
- The safety switches parse with a safe default: an unrecognised `SHADOW_MODE` value leaves
  shadow mode **on**.

## What the consultant sees

Every booking proposal shows:

- the debit/credit rows, with cost center, project and VAT code,
- the endpoint (`POST /3/vouchers`),
- the complete JSON body, verbatim,
- the payload hash,
- a banner stating the request was constructed and validated but never sent.

The top bar of the review app fetches the live safety posture from `/api/system/status` rather
than hard-coding it, so it reports what the running system is actually configured to do.

## Verification

Shadow mode is asserted, not assumed:

| Assertion | Where |
| --- | --- |
| The gate blocks on every single failing condition | `packages/fortnox/src/write-policy.test.ts` |
| Both adapters refuse to write | same file |
| The real adapter refuses write-enabled construction under shadow mode | same file |
| No audit event ever carries a Fortnox id | `packages/workflow/test/close-run.itest.ts`, `apps/api/test/api.itest.ts` |
| Proposals persist as `simulated` only | close-run integration test |
| An approval changes internal status only | close-run integration test, API integration test |
| Customer requests are never sent | close-run integration test, smoke test |
| The end-to-end flow holds shadow mode | `scripts/smoke.ts` — 32 checks |

## Lifting shadow mode (not in this phase)

In order, none of which may be skipped:

1. Re-verify the Fortnox contract field-by-field against live documentation (see the
   capability matrix's re-verification checklist).
2. Implement the real adapter's read path and validate it against a **sandbox** Fortnox
   account.
3. Implement OAuth2 with the token in a secret manager, never in this database.
4. Add per-client `writesEnabled` with an audited administrative action to set it.
5. Wire `approvalDecisionId` and `approvedPayloadHash` from the review UI into the write path.
6. Enable writes for **one** low-risk proposal type (the dimension reclassification) for
   **one** pilot client, with a kill switch.
7. Reconcile every write against Fortnox afterwards and alert on divergence.

Steps 1–4 are phase-2 work. Steps 5–7 should not begin until a period has been run in shadow
mode against a real account and the proposals have been reviewed by a consultant who agrees
with them.
