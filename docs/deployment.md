# Deployment

Two services and a database. The repository ships a Dockerfile per app plus
ready-made configuration for Render and Railway, so the whole thing can be
deployed from a browser with no local tooling.

> **Before you publish a URL, read [Security](#security).** Phase 1 has no
> authentication. The password gate below is what makes a shareable link
> acceptable; it is not a substitute for the work in
> [`security-and-permissions.md`](./security-and-permissions.md).

---

## What gets deployed

| Component | Image | Notes |
| --- | --- | --- |
| `trimeros-api` | `apps/api/Dockerfile` | Fastify. Runs migrations on boot; seeds the demo tenant when `SEED_ON_BOOT=true`. |
| `trimeros-web` | `apps/web/Dockerfile` | Next.js. Every page is force-dynamic, so the build needs no API and no database. |
| `trimeros-db` | managed Postgres | Set `DB_DRIVER=postgres` and point `DATABASE_URL` at it. |

---

## Vercel — the console only

Vercel suits `apps/web` and cannot run `apps/api`. Worth stating plainly, because
pointing a Vercel project at `apps/api` produces a build failure whose message
("Property 'ok' does not exist on type 'Response'") says nothing about the real
problem:

- the API's only entrypoint is `start: tsx src/server.ts` — a process that
  listens. There is no `build` script and no output directory to serve;
- the default database driver is PGlite, which writes to local disk. Vercel's
  filesystem does not persist between invocations;
- the Fortnox OAuth work stores sealed refresh tokens, which needs a durable
  Postgres.

So: **console on Vercel, API on Render or Railway.**

### Settings

| Setting | Value |
| --- | --- |
| Root Directory | `apps/web` |
| Framework preset | Next.js (auto-detected) |
| Build / install command | leave as detected — Vercel reads the workspace lockfile at the repo root |

### Environment variables

| Variable | Value |
| --- | --- |
| `API_BASE_URL` | the deployed API's public base URL, e.g. `https://trimeros-api.onrender.com` |
| `DEMO_USER` / `DEMO_PASSWORD` | only if the API runs the password gate — the console presents them server-side, and they never reach the browser |
| `DEMO_TENANT_ID` | only to override the demo tenant |

`API_BASE_URL` is read server-side on every request; there is no build-time
baking, so changing it needs a redeploy but no rebuild of the code.

With `API_BASE_URL` unset or unreachable the console still renders — the
overview and the shell both catch the failure and say the API could not be
reached, rather than showing a stack trace. That is a degraded state, not a
crash, and it is what a first deploy looks like before the API exists.

### Do not deploy the API here

If a Vercel project already points at `apps/api`, change its Root Directory to
`apps/web` or delete the project. Left alone it marks every pull request red
regardless of the code, which trains everyone to ignore a red mark.

---

## Render (free)

1. Push the repository to GitHub.
2. Render → **New** → **Blueprint** → select the repository.
3. Render reads [`render.yaml`](../render.yaml) and creates both services plus the
   database.
4. When prompted, set **`DEMO_PASSWORD`** on both services to the same value.
   It is marked `sync: false`, so it is never committed.
5. First deploy takes a few minutes. Open the `trimeros-web` URL and sign in with
   `demo` and your password.

**Free-plan caveats, stated plainly:** services sleep after inactivity and take
roughly 30 seconds to wake, and a free Postgres instance expires after 30 days.
Fine for showing the demo; not a place to leave it running.

## Railway (~5 USD/month, always awake)

Railway configures services in its UI rather than from one blueprint file, so it
is three short steps instead of one:

1. **New Project** → **Deploy from GitHub repo**.
2. Add **Postgres** from the project's Add menu.
3. Create two services from the same repository. For each, open
   **Settings → Config as code** and point it at:
   - API → `railway.api.json`
   - Web → `railway.web.json`
4. Set the variables below on each service. Railway exposes the database as
   `${{Postgres.DATABASE_URL}}` and the sibling service host as
   `${{trimeros-api.RAILWAY_PUBLIC_DOMAIN}}`.

## Environment variables

**API**

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | from the managed database | |
| `DB_DRIVER` | `postgres` | Switches off the in-process PGlite driver |
| `SEED_ON_BOOT` | `true` | Seeds the demo tenant on start; idempotent |
| `DEMO_USER` / `DEMO_PASSWORD` | `demo` / your choice | Password gate |
| `WEB_ORIGIN` | the web service's URL | Replaces the permissive local CORS |
| `SHADOW_MODE` | `true` | Keep true until a full period has been reviewed - see `docs/shadow-mode.md` |
| `FORTNOX_WRITES_ENABLED` | `false` | Turning it on also needs `SHADOW_MODE=false`, `FORTNOX_WRITES_ACKNOWLEDGEMENT` and a non-mock adapter |
| `FORTNOX_ADAPTER` | `mock` or `auto` | `auto` reads connected clients from Fortnox; needs the OAuth variables in `docs/fortnox-oauth.md` |
| `MODEL_PROVIDER` | `fake` | No AI key needed |

**Web**

| Variable | Value |
| --- | --- |
| `API_BASE_URL` | the API service's internal or public URL |
| `DEMO_USER` / `DEMO_PASSWORD` | the same values as the API |

`PORT` is injected by the platform. Do not set it: the API binds `0.0.0.0`
whenever `PORT` is present and stays on loopback locally, which is the safe
default for a service with no authentication.

---

## Security

What the password gate does: one shared credential in front of every route on
both services, except `/health` so platform health checks keep working.
Constant-time comparison, no session, no cookie.

What it does not do: it is not authentication, it does not identify a user, and
it does not isolate tenants. The gaps in
[`security-and-permissions.md`](./security-and-permissions.md) all still stand.

Why hosting this is nonetheless low-risk today: the data is entirely synthetic,
the only adapter compiled into the image is the mock, and the API refuses to
start with writes enabled or with the real adapter selected. The worst a visitor
can do is run a close run over fictional data.

**Do not point a hosted instance at a real Fortnox account.** That needs phase 2
and phase 4 from [`next-phases.md`](./next-phases.md).

---

## Verification status

Honest about what was and was not tested:

| Checked | How |
| --- | --- |
| The `postgres` driver — migrations, seed, queries, exact `numeric` money, `jsonb` arrays, idempotency | `packages/db/test/postgres-driver.itest.ts`, which serves PGlite over the real Postgres wire protocol and connects with `postgres-js`, exactly as a deployment does |
| Host and port resolution, the CORS allowlist, the password gate | `apps/api/test/deploy-config.itest.ts` |
| The production web build | `pnpm build` in CI |
| The console's production build, from `apps/web` as its own root | `pnpm build`, which runs `next build` in `apps/web` exactly as Vercel would |
| **Not checked: the Docker images build and run** | No Docker daemon was available in the environment where this was written. The Dockerfiles follow the standard pnpm-workspace pattern but have never been executed. Expect to iterate on the first deploy. |

---

## Local Postgres instead of PGlite

```bash
pnpm db:up                 # docker compose, postgres on :5433
# set DB_DRIVER=postgres in .env
pnpm db:deploy             # migrate + seed
pnpm dev
```
