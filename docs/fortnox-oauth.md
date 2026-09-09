# Fortnox OAuth connection

How a client's Fortnox account gets connected, what that connection can and
cannot do, and what has to be set up before the button works.

---

## What this is, and what it is not

The connection is **read-only, and connecting does not switch the workflow onto
live data.**

| | |
| --- | --- |
| **Works today** | Registering the app, consent, token exchange, sealed token storage, refresh with rotation, a live verification call, disconnect with revocation, and the console page that drives all of it. |
| **Not yet** | Reading a client's real bookkeeping. `RealFortnoxAdapter`'s read methods are still `not_implemented`, and close runs still analyse the synthetic dataset. |
| **Never, in this phase** | Writing anything. No write scope is requested, and `evaluateWriteGate` fails under shadow mode regardless of what is stored. |

So a connected client is a client whose credential is in place and proven to
work. Wiring those reads into the workflow is the next phase — see
`docs/next-phases.md`.

---

## Verification status of this document

Fortnox's own hosts are blocked by this environment's network policy (`403` on
`CONNECT` to `www.fortnox.se`, `developer.fortnox.se` and `apps.fortnox.se`), so
nothing here was confirmed by fetching the documentation directly. It was
corroborated through a search index over Fortnox's official authorization
pages, the same method and the same limitation as
`docs/fortnox-capability-matrix.md`.

| Detail | Status |
| --- | --- |
| Authorize endpoint `https://apps.fortnox.se/oauth-v1/auth` | Corroborated |
| Token endpoint `https://apps.fortnox.se/oauth-v1/token` | Corroborated |
| HTTP Basic with `client_id:client_secret`, form-encoded body | Corroborated |
| Authorization code single-use, ~10 minutes | Corroborated |
| Access token ~1 hour; refresh token ~45 days; refresh **rotates** | Corroborated |
| `access_type=offline` required to receive a refresh token | Corroborated |
| Scope names `bookkeeping`, `invoice`, `supplierinvoice`, `customer`, `supplier`, `payment`, `companyinformation` | Corroborated |
| Scope name `costcenter` | **Unverified** — requested, and a rejected consent naming it is the thing to check first |
| Revoke endpoint `https://apps.fortnox.se/oauth-v1/revoke` | **Unverified** — failure is tolerated; disconnect still deletes the local credential |
| Resource path `/3/companyinformation` and its response shape | **Unverified** — follows the same convention as the verified paths; a wrong path shows up as `company_check_http_404` on the settings page |

Every endpoint is overridable by environment variable, so a correction needs no
code change.

---

## One-time setup (the developer)

### 1. Register the app at Fortnox

In the Fortnox developer portal, create an integration and note the
**Client ID** and **Client Secret**. Register this exact redirect URI:

```
https://<your-api-host>/api/integrations/fortnox/callback
```

It must match character for character — a trailing slash is a mismatch. The
settings page prints the URI the running system will actually send, under
**Teknisk information**; copy it from there rather than typing it.

### 2. Generate a token-encryption key

```bash
pnpm fortnox:keygen
```

32 random bytes, base64. Refresh tokens are sealed with it (AES-256-GCM) before
they reach the database. There is no plaintext fallback: without a valid key the
API refuses to start rather than storing tokens in the clear.

Rotating the key makes every stored token unreadable and every client has to
reconnect. Safe, but disruptive — keep it in the platform's secret store.

### 3. Set the environment

```bash
FORTNOX_CLIENT_ID=...
FORTNOX_CLIENT_SECRET=...
FORTNOX_TOKEN_ENCRYPTION_KEY=...      # from pnpm fortnox:keygen
API_PUBLIC_URL=https://api.example.com    # the API's own public base URL
WEB_BASE_URL=https://console.example.com  # where the callback returns the browser
```

Until all four are set the settings page says which are missing and offers no
button. That is deliberate: "not set up yet" and "broken" should not look alike.

---

## What Marcus does

1. Open the console → **Fortnox-anslutning**.
2. Read what is being asked for. The page lists every scope in plain Swedish and
   states what the system will and will not do, *before* the button.
3. **Anslut till Fortnox** → log in at Fortnox → approve.
4. Fortnox returns the browser to the console, which reports the company name it
   read back.

If it says **Ansluten** with the right company name, it is done. He never sees a
token, a client secret, or an environment variable.

What the connection is *used* for depends on the server's `FORTNOX_ADAPTER`:

| `FORTNOX_ADAPTER` | Connected client | Client without a grant |
| --- | --- | --- |
| `mock` (default) | demo data | demo data |
| `auto` | **read-only from Fortnox** | demo data (if it has the demo row), else blocked |
| `real` | **read-only from Fortnox** | blocked with a Swedish reason in the readiness step |

The settings page states which of these is in effect, so "connected" is never
confused with "in use". A run records its data source on the close run and shows
it in the period view.

---

## How it works

```
console          API                          Fortnox
  │  POST connect │                              │
  │──────────────>│ store hash(state), 10 min    │
  │<──authorize URL                              │
  │                                              │
  │─────────── browser redirect ────────────────>│  login + consent
  │                                              │
  │              │<───── GET callback?code&state─│
  │              │ claim state (atomic, once)    │
  │              │ POST /oauth-v1/token ────────>│
  │              │<──── access + refresh ────────│
  │              │ seal both, store              │
  │              │ GET /3/companyinformation ───>│
  │<─ redirect ──│ record company name           │
```

### Why the callback is not behind the password gate

Every other route is. The callback is opened by Fortnox's redirect in whatever
browser state the person happens to be in, so a shared demo password is the
wrong check — and a gated callback would fail for anyone whose browser did not
hold it. It carries a stronger credential instead: `state` is 256 CSPRNG bits,
stored only as a SHA-256 hash, valid ten minutes, and claimed by the same
`UPDATE` that returns it, so a replay finds nothing.

### Why refreshes are never retried

Fortnox invalidates the old refresh token the moment it issues a new one. A
retry after a lost response presents a credential the server has already spent,
turning a recoverable timeout into a dead connection. So: no retries, and two
guards against concurrent refreshes —

- refreshes for one connection share a single in-flight promise, and
- the write that persists a rotation is a compare-and-set on `rotation_count`,
  so a loser re-reads instead of overwriting the live token with a dead one.

### Where credentials live

`integration_credentials`, separate from `integration_connections`, so that
reading connection status — which the UI does constantly — never loads a
credential. Each ciphertext is bound to its tenant/client/kind as additional
authenticated data: a row lifted into another client's row fails its auth tag
instead of decrypting.

Nothing model-facing can reach a token. `getAccessToken` is called by the HTTP
adapter and by nothing else, audit events carry a keyed 12-character
fingerprint rather than the token, and no API response has a token field to
leak.

### Two connection kinds, on purpose

A client normally has both rows:

- `fortnox` — where a close run reads its data. Still the mock adapter.
- `fortnox_oauth` — the live grant, its sealed tokens and last check.

They answer different questions. Conflating them would mean a client who
connected their real account silently changed what a run reads. Every lookup
names the kind it wants; see `FORTNOX_DATA_SOURCE_KIND` and
`FORTNOX_CONNECTION_KIND` in `@trimeros/domain`.

---

## When something goes wrong

| Shown | Means | Fix |
| --- | --- | --- |
| `invalid_state` | Link reused, or older than ten minutes | Start again from the console |
| `access_denied` | Consent refused or cancelled at Fortnox | Try again; check the Fortnox user's permissions |
| `invalid_client` | Fortnox does not recognise the app | Check `FORTNOX_CLIENT_ID` / `FORTNOX_CLIENT_SECRET` |
| `invalid_grant` on a later call | Refresh token dead or >45 days unused | The console asks for a reconnect; the dead credential is deleted |
| `company_check_http_404` | Token works, the verification path does not | The `/3/companyinformation` path is unverified — confirm it and set `FORTNOX_API_BASE_URL` if needed |
| `company_check_http_401` | Grant rejected by the API | Reconnect |
| Redirect-URI mismatch at Fortnox | Registered URI ≠ sent URI | Copy it from **Teknisk information** on the settings page |

A refused verification does **not** silently pass: the page shows *Ansluten
(obekräftad)* with the code, because a token nobody has used is a guess.

---

## Before this points at a real account

1. Re-verify every **Unverified** row above against the live documentation.
2. Confirm `costcenter` is a real scope; drop it if not.
3. Confirm the `/3/companyinformation` path and response shape.
4. Keep `SHADOW_MODE=true` for the first full period. Connecting is read-only;
   writing is a separate ladder of switches — see `docs/shadow-mode.md` and, in
   Swedish, `docs/autonomi.md`.

## The per-client write switch

The same page hosts *Skrivbrytare för klienten*: condition 3 of the seven in the
write gate. It is refused (HTTP 409) while the server runs in shadow mode, it is
audited as `integration.writes_toggled`, and turning it on does nothing on its
own - the server-side flag, the acknowledgement phrase and an approval bound to
the exact payload are all still required for a single voucher to be created.
