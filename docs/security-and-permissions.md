# Security and permissions

## Threat model in one paragraph

This system holds a Swedish accounting firm's view of its clients' books, and — in a later
phase — credentials that can write to those books. The three consequences worth designing
against are: one firm reading another firm's data, a credential leaking into a log or a model
prompt, and an incorrect or unauthorised posting reaching Fortnox. Everything below exists to
address one of those three.

---

## Tenant isolation

**Model:** the accounting firm is the tenant. `Client` is the end client whose books are being
worked on.

| Layer | Mechanism |
| --- | --- |
| Schema | Every table carries `tenantId`. Every unique constraint is scoped by it — e.g. `findings_dedup_uq (tenant_id, close_run_id, deduplication_key)`. |
| Repository | Every method takes a `TenantScope` as its first argument. Every generated `WHERE` starts with `tenant_id = ...`. There is no method that reads without naming a tenant. |
| HTTP | The tenant comes from `x-tenant-id` and is passed straight into the repository scope. |
| Test | An integration test asserts a second tenant sees zero clients, zero findings, and a 404 on another tenant's close run. |

**Known gap, phase 1:** the tenant header is **not authenticated**. Anyone who can reach the
API can name any tenant. This is acceptable only because the API binds to `127.0.0.1` by
default and the only data is synthetic. It is the single largest thing to fix before this is
exposed to a second firm.

**Phase 2 must add:** real authentication (OIDC), a session-derived tenant that the client
cannot choose, and **Postgres row-level security** so a bug in a repository cannot leak across
tenants. The column and index design was chosen so RLS is a policy addition, not a migration.

---

## Roles

`UserRole` is defined (`owner`, `consultant`, `reviewer`, `read_only`) and stored, but **not
yet enforced** — phase 1 has no authentication to enforce it against. The intended mapping:

| Role | Read | Run a close run | Decide in review | Approve a future Fortnox write |
| --- | --- | --- | --- | --- |
| `owner` | ✅ | ✅ | ✅ | ✅ |
| `consultant` | ✅ | ✅ | ✅ | ✅ |
| `reviewer` | ✅ | ❌ | ✅ | ❌ |
| `read_only` | ✅ | ❌ | ❌ | ❌ |

---

## Secrets

**Rule: no secret is ever stored in this database, logged, or placed in a model prompt.**

| Secret | Where it lives | Where it must never appear |
| --- | --- | --- |
| Fortnox OAuth client secret | Environment / secret manager | Database, logs, audit events, prompts |
| Fortnox access & refresh token | `integration_credentials`, sealed with AES-256-GCM | Logs, audit events, prompts, API responses — and never in plaintext at rest |
| OpenAI API key | Environment, read once at provider construction | Request body, logs, audit events |

`IntegrationConnection` stores a `credentialRef` — a pointer — and never a credential value. The
column is nullable and is `null` for the mock adapter.

Once a client connects over OAuth the tokens are persisted, because a refresh token has to
outlive the process that received it. They are sealed with AES-256-GCM under
`FORTNOX_TOKEN_ENCRYPTION_KEY` before they reach the database, bound to their own
tenant/client/kind as additional authenticated data, and kept in `integration_credentials`
rather than on the connection row so that reading connection status never loads a credential.
There is no plaintext fallback: with no valid key the API refuses to start. Audit events carry a
keyed 12-character fingerprint, never the token. See [`fortnox-oauth.md`](./fortnox-oauth.md).

A unit test asserts the OpenAI provider never places the key anywhere but the `Authorization`
header.

`.env.example` ships with every secret field empty, and `.env` is git-ignored.

---

## The audit log

`AuditEvent` records, per the requirement: tenant, client, actor, timestamp, operation, input
references, rule version, prompt version, model provider and name, tool call, proposed
payload, approved payload, result, Fortnox id, error, and correlation id.

**Two things it must never contain: secrets, and documents or sensitive free text.**

This is enforced structurally rather than by convention. Every audit write in the codebase
goes through `createAuditWriter`, which calls `redactAuditPayload` on both payload fields.
That function:

- replaces the value of any forbidden key with `[redacted]` — case-insensitively, at any depth
  (`access_token`, `refresh_token`, `client_secret`, `api_key`, `authorization`, `password`,
  `token`, `credential`, `personnummer`, `filecontent`, `base64`, `attachment`, …);
- truncates any string over 512 characters, so a document body cannot arrive as free text;
- caps arrays at 200 entries and nesting at 6 levels.

What it deliberately keeps: structured accounting data. `{Voucher: {VoucherRows: [{Account:
5010, Debit: 25000}]}}` passes through untouched, because that is the evidence the log exists
for.

Documents themselves are **never** copied into this system. `SourceDocument` holds an
`externalRef` into the Fortnox archive and nothing more — one archive, not two.

---

## The model boundary

The language model is treated as an untrusted component that produces text.

**What it receives:** a hand-built object of counts, amounts, severities, step labels and rule
rationales. Nothing is passed through automatically from the database or from Fortnox.

**What it cannot reach:** the database, the Fortnox adapter, any credential, the filesystem,
the network. It is given no handle to any of them.

**Tools:** the allowlist has two entries, both read-only lookups (`lookup_account_description`,
`lookup_rule_explanation`). Neither is auto-executed in phase 1 — requested tool calls are
recorded in the audit log and ignored. A unit test asserts every allowlisted tool is
`readOnly` and that no tool name matches `/fortnox|write|sql|query|book/i`.

**Prompt injection:** the realistic vector is a supplier name or voucher description
originating from a client's books. Mitigations: model output is parsed against a strict schema
and rejected if it does not match; the output lands in a report field and cannot alter a
decision, amount or status; and no tool exists that a successful injection could usefully call.

**Output validation:** structured output only, validated with zod. A malformed response raises
`ModelOutputValidationError` and is **not** retried — retrying a schema failure burns tokens on
a prompt bug.

---

## Approval and write authorisation

The three-level decision model (`automatic` / `review` / `manual_assessment`) governs what may
happen without a human. `automatic` means the proposal passed every hard gate and scored at or
above the threshold; whether the *system* may approve it is a per-client policy switch
(`autoBookEnabled`, audited as `policy.updated`), and such an approval is recorded as an
`ApprovalDecision` with `actorKind: 'system'` and `decidedByUserId: 'system:policy-auto-approver'`.

Every decision - human or system - carries `approvedPayloadHash`, the hash of the exact payload
it approves. The write gate in `packages/fortnox/src/write-policy.ts` requires seven independent
conditions, including that hash matching the bytes about to be sent. A submission claims the
proposal with a compare-and-set before posting and records the booked hash afterwards, so the
same correction is never booked twice. See [`shadow-mode.md`](./shadow-mode.md).

The real adapter's access token is obtained per request from `FortnoxConnectionService`, lives
in `FortnoxHttpClient` only, and appears in no error, log line, audit row or response.
`FortnoxApiError` carries the path and Fortnox's own error code.

---

## Known gaps (phase 1)

Stated plainly rather than buried:

1. **No authentication.** The tenant header is unauthenticated.
2. **No authorisation.** Roles are stored, not enforced.
3. **No row-level security.** Isolation is repository-enforced, not database-enforced.
4. **No rate limiting** on the API.
5. **No encryption at rest** configured beyond whatever the Postgres deployment provides.
6. **CORS is `origin: true`** — correct for local development, wrong for anything else.
7. **No secret manager integration.** `AccessTokenProvider` is an interface with no production
   implementation.

None of these is dangerous while the system runs locally against synthetic data with writes
disabled. All of them are blocking for a pilot with a real client. They are the top of
[`next-phases.md`](./next-phases.md).
