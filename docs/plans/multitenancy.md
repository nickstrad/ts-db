# Plan: Multitenancy — Postgres central DB, per-tenant SQLite, admin CLI

Status: proposed · Date: 2026-10-10 · Target branch: feature branches off `main`, one commit per item.

Builds on: `docs/plans/effect-port-and-observability.md` items 01–29 complete. This plan is additive — it does
not modify that plan. Where this plan touches files owned by earlier items, it extends them (new config rows,
new routes, new service methods), never rewrites them.

## 0. Where the code is today (multitenancy-relevant surface)

Verified by reading the repo on 2026-10-10.

| Surface                | Today                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/client.ts`        | `createClient(baseURL, appId, token)` → `POST {baseURL}/apps/{appId}/{kind}/{name}` with `authorization: Bearer <token>` and `x-trace-id`                |
| `platform/config.ts`   | Options table (`name`, env var, type, default, description): `adminToken`, `dataDir`, `s3BaseUrl`, `awsRegion`, … — the ONLY place that reads `Deno.env` |
| `platform/services.ts` | `Context.Tag` declarations: `Config`, `Storage`, `Reader`, `ObjectStore`, `Backups`, …                                                                   |
| `platform/server.ts`   | Regex routing; `/admin/*` guarded by `ADMIN_TOKEN` bearer check                                                                                          |
| Item 15 `Storage`      | `Semaphore(1)` serialized writer queue over a **single** SQLite file, `BEGIN IMMEDIATE`                                                                  |
| `docker-compose.yml`   | SeaweedFS only, plus a commented template block for adding services; `Makefile`: `up/down/restart/ps/logs/clean`                                         |
| Auth                   | Per-app static tokens (`columnAppToken`, `jsonAppToken`); no users, no sessions                                                                          |

## 1. Target architecture

```text
Postgres (docker-compose, new)          Per-tenant SQLite files
┌──────────────────────────┐           ┌─────────────────────────────────┐
│ tenants(id, slug, name,   │           │ <TENANTS_DIR>/<tenant-id>.db    │
│   status, created_at)     │           │ (one file per tenant, same DDL) │
│ api_keys(id, tenant_id,   │           │                                 │
│   key_hash, prefix, name, │           │ routed via TenantStorageRouter │
│   revoked_at, created_at) │           │ (local folder now; control-plane│
│ users/session/account/   │           │  pluggable later)               │
│   (Better Auth tables)   │           └─────────────────────────────────┘
└──────────────────────────┘                        ▲
         ▲                                          │ Storage depends only
         │ TenantRegistry (Effect service)          │ on the router tag
         │                                          │
Client ──┼── Authorization: Bearer <api-key> ───────┘
         │         │
         │         ▼
         │   server resolves tenant server-side
         │   from the key hash (cached); the tenant
         │   id is NEVER trusted from client params
         │
Admin ───┴── scripts/tenants.ts → /admin/tenants/* (ADMIN_TOKEN)
```

**The load-bearing rule** (from the Convex/Auth0 research in §2): tenant identity is derived server-side from
the credential on every request. A client-supplied tenant id is never trusted — a cross-tenant read must
behave exactly like reading a row that does not exist.

**Tenancy model:** database-per-tenant at the SQLite layer (one file per tenant — the human's explicit
choice), single shared Postgres for the central registry. This matches the platform's existing shape (SQLite
files are already the unit of backup/restore in item 19) and keeps tenant data physically separable. Routing
to those files goes through the `TenantStorageRouter` interface (MT-04) — never hardcoded paths — so a future
control-plane router plugs in as a different layer with no changes to `Storage`, the tenant middleware, or the
client.

## 2. Research

### 2.1 How Convex and other BaaS clients pass tenant context

- **Convex.** The deployment URL is the tenant boundary for the platform itself — the client connects to a
  deployment URL and Convex routes by it. _Within_ one deployment, multi-tenant SaaS is app-level: every
  tenant row carries an `organizationId` (e.g. the Clerk organization ID), the server derives
  `{ userId, orgId, role }` from the auth JWT via `getAuthContext(ctx)`, and queries filter on an indexed
  `by_company`-style index. Tenant context comes from the **token**, never from client parameters. (Sources:
  Convex project-configuration docs — `CONVEX_DEPLOYMENT` env + deployment URL; dev.to Convex Champions
  multi-tenant walkthrough — `companyId` scoping pattern.)
- **Auth0 Organizations.** The client passes `organization=<org_id>` at authorize time; the org lands in the
  token claims and the API trusts the claims, not a request field. (Source: Auth0 multi-tenancy Organizations
  guide.)
- **App-layer isolation pattern** (sveltekit-cf-template `docs/multi-tenancy.md`): the Actor is derived from
  the session by the route, never from the request body; services scope every query by `organization_id`; a
  cross-tenant read returns nothing.
- **Decision for ts-db:** the existing `Authorization: Bearer <token>` header carries a **tenant-scoped API
  key** (or, after MT-08, a Better Auth session token). The server hashes the presented key, looks up the
  tenant in Postgres, and injects the tenant id into the Effect layer. The TS client's `token` parameter
  becomes that key — no new client field is needed, which keeps the `createClient(baseURL, appId, token)`
  signature stable.

### 2.2 Better Auth headless (no webapp): VIABLE

Researched against current docs (better-auth.com, Oct 2026) and field reports:

1. **Server is framework-agnostic.** Official docs: "Better Auth supports any backend framework with standard
   Request and Response objects." `auth.handler` is a plain web handler mountable at `/api/auth/*` on
   `Deno.serve` or the Effect `HttpRouter`. Field evidence: an Effect-TS codebase mounts it via
   `HttpRouter.add("*", "/api/auth/*", ...)` with zero Next.js involved.
2. **Vanilla JS client exists.** Official docs: "Better Auth comes with a client for all the popular web
   frameworks, including vanilla JavaScript" — `createAuthClient` from `better-auth/client` is fetch-based and
   runs in a Deno CLI.
3. **Email/password is built-in:** `emailAndPassword: { enabled: true }`; no email sending is needed when
   `requireEmailVerification: false`.
4. **Known CLI wrinkle (not a blocker):** sessions are cookie-based by default; a headless CLI must capture
   the session token from the sign-in response and send it back explicitly. MT-08 therefore starts with a
   **verification spike**: if the token cannot be captured and used headlessly, the item stops and the plan
   falls back to API-keys-only (auth deferred) — the human's stated punt condition, documented in the item.

**Auth decision: proceed with Better Auth email/password headless, with the MT-08 spike as the go/no-go
gate.** If the spike fails, MT-08 closes as headless-infeasible and opaque API keys remain the identity story;
no other item depends on MT-08.

### 2.3 Postgres in docker-compose

Standard pattern, following the file's existing commented template: `postgres:17` image,
`POSTGRES_DB/USER/PASSWORD` env (dev defaults documented, never committed secrets), `pg_isready` healthcheck,
named volume `pg-data`. `make up` already waits on healthchecks, so no Makefile logic changes are needed —
only a `db-shell` convenience target.

## 3. Batch table

| Batch | Items        | Scope                                             | Gate                                                             |
| ----- | ------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| MT-A  | MT-01, MT-02 | Postgres service + schema; config options         | concurrent (disjoint files)                                      |
| MT-B  | MT-03, MT-04 | TenantRegistry service; per-tenant SQLite routing | concurrent (MT-04 takes tenant id as a plain param)              |
| MT-C  | MT-05, MT-06 | Admin CRUD endpoints; admin CLI                   | MT-06 after MT-05 (CLI dogfoods the endpoints)                   |
| MT-D  | MT-07, MT-08 | Tenant resolution in request path; Better Auth    | MT-08 after MT-07 (needs the tenant-context seam)                |
| MT-E  | MT-09        | Property tests for tenant routing invariants      | after MT-03 and MT-04 (needs the registry and router interfaces) |

Model policy (same as the main plan): **Opus** for security boundaries and resource lifetimes; **Sonnet** for
bounded, mechanical items with checkable acceptance.

---

#### MT-01 — Postgres in docker-compose + central schema

- **Scoping:** CONCURRENT with MT-02.
- **Model:** **Sonnet.** Mechanical: one service block following the file's template, one SQL file.
- **Owns:** `docker-compose.yml` (additive `postgres` service block + `pg-data` volume),
  `platform/tenants/schema.sql`, `Makefile` (additive `db-shell`, `db-migrate` targets only).
- **Reads:** `docker-compose.yml` (template block), `Makefile`.
- **Work:**
  1. `postgres:17` service: `POSTGRES_DB/USER/PASSWORD` from env with dev defaults, `pg_isready -U <user>`
     healthcheck, named volume `pg-data`, resource limits matching the file's style.
  2. `platform/tenants/schema.sql`:
     `tenants(id uuid PK, slug text UNIQUE, name text, status text DEFAULT 'active', created_at timestamptz)`;
     `api_keys(id uuid PK, tenant_id uuid REFERENCES tenants, key_hash text UNIQUE, prefix text, name text, revoked_at timestamptz, created_at timestamptz)`;
     index on `api_keys(key_hash)`.
  3. `make db-migrate`: applies `schema.sql` via psql (idempotent — `CREATE TABLE IF NOT EXISTS`);
     `make db-shell`: psql into the DB.
- **Acceptance criteria:**
  - `make up` → postgres reports healthy; `make db-migrate` → `\dt` lists `tenants`, `api_keys`.
  - `make down && make up` → tables persist (volume).

#### MT-02 — Config options for multitenancy

- **Scoping:** CONCURRENT with MT-01.
- **Model:** **Sonnet.** Follows the item-08 options-table pattern exactly.
- **Owns:** `platform/config.ts` (additive rows only), `README.md` "Configuration" section (additive).
- **Reads:** `platform/config.ts` (options table).
- **Work:** Add `databaseUrl` (default `postgres://tsdb:tsdb@localhost:5432/tsdb`), `tenantsDir` (default
  `<dataDir>/tenants`), `tenantRouter` (default `"local"`; validated against the known router kinds —
  `"local"` today, `"control-plane"` reserved for the future), `betterAuthSecret` (no default — required when
  auth enabled), `betterAuthUrl` (default `http://localhost:3000`-style platform base URL). Keep the README
  section in sync (reviewer verifies parity, per the item-08 precedent).
- **Acceptance criteria:**
  - `ConfigLive` decodes the new options; missing `betterAuthSecret` fails with `ConfigError` only when auth
    is enabled.
  - Reviewer verifies README lists exactly the new options.

#### MT-03 — TenantRegistry service (Effect)

- **Scoping:** CONCURRENT with MT-04.
- **Model:** **Opus.** Security boundary: key generation, hashing, uniqueness.
- **Owns:** `platform/tenants/registry.ts`, `platform/tenants/store.ts`, `tests/unit/tenants_test.ts`.
- **Reads:** `platform/services.ts`, `platform/config.ts`, `core/errors.ts`.
- **Work:**
  1. `TenantRegistry` `Context.Tag` + interface in the `services.ts` style: `createTenant({name, slug})`,
     `getTenant(id)`, `listTenants()`, `updateTenant(id, patch)`, `deactivateTenant(id)`,
     `issueApiKey(tenantId, name)`, `revokeApiKey(keyId)`, `resolveTenantByKeyHash(hash)`.
  2. `store.ts`: Postgres access via a single pinned driver (pick `npm:postgres` or `npm:pg`, justify in a
     code comment). API keys: `tsdb_` prefix + 32 random bytes; **SHA-256 hash stored**, plaintext returned
     exactly once at issuance; `resolveTenantByKeyHash` joins `api_keys` → `tenants` and rejects revoked keys
     and inactive tenants.
  3. Unit tests with a test layer (ephemeral Postgres via `make up` in CI, or pg-mem if the driver allows —
     builder's choice, documented).
- **Acceptance criteria:**
  - `deno task test` passes; tests cover: duplicate slug rejected, key plaintext shown once (second read
    impossible), revoked key rejected, inactive tenant's keys rejected, `resolveTenantByKeyHash` round-trip.

#### MT-04 — Tenant storage routing: interface + local-folder implementation

- **Scoping:** CONCURRENT with MT-03.
- **Model:** **Opus.** Interface design plus resource lifetimes (one SQLite handle per tenant, bounded cache,
  idle eviction).
- **Owns:** `platform/tenants/routing.ts`, `platform/sqlite.ts` (additive),
  `tests/unit/tenant_routing_test.ts`.
- **Reads:** `platform/sqlite.ts` (item 15), `platform/services.ts`.
- **Work:**
  1. **Define the interface** in `routing.ts` — `TenantStorageRouter` as a `Context.Tag`, in the `services.ts`
     style. Routing goes through this interface; paths are never hardcoded in `Storage` or anywhere else:
     - `resolve(tenantId: TenantId): Effect<StorageLocation, TenantError>` — the contract: map a tenant to
       _where its data lives_. Performs no storage I/O itself.
     - `StorageLocation` is a tagged union: `{ _tag: "SqliteFile", path: string }` today; future kinds (e.g.
       `{ _tag: "ControlPlane", endpoint: string }`) extend the union without touching the interface.
     - `prepare(location: StorageLocation): Effect<void, TenantError>` — idempotent: ensure the location
       exists and carries the schema DDL (creates the file on first use for the local implementation).
     - Contract guarantees: `resolve` is deterministic per tenant id; implementations must reject malformed
       ids so path traversal is impossible by construction; `Storage` depends **only** on the
       `TenantStorageRouter` tag — never on paths, env vars, or a concrete router.
  2. **Local-folder implementation now:** `LocalFolderRouter` — `resolve` returns
     `{ _tag: "SqliteFile", path: "<tenantsDir>/<tenantId>.db" }`; the tenant id is a validated uuid (assert:
     no `..`, no separators). Selected via the `tenantRouter: "local"` config value.
  3. **`sqlite.ts`:** `Storage` gains tenant-scoped access through the router — a bounded
     `Map<tenantId, handle>` with idle eviction keyed off `resolve`; **each tenant file keeps item 15's
     guarantee** (own `Semaphore(1)` queue, `BEGIN IMMEDIATE`). The single-file path remains for the
     pre-tenancy default (back-compat for existing deployments).
  4. **Document the extension point** in `routing.ts` header comments: a future `ControlPlaneRouter` (central
     routing service, remote files, whatever comes later) implements `TenantStorageRouter`, is selected via
     `tenantRouter: "control-plane"` + endpoint config, and plugs in as a different layer — no changes to
     `Storage`, the tenant middleware, or the client wiring.
- **Acceptance criteria:**
  - A test builds `Storage` against a stub `TenantStorageRouter` pointed at a temp dir and proves `Storage`
    never reads paths or env directly — the router is the only seam.
  - Two tenants write the same document id → fully isolated reads.
  - 50 concurrent writes across 5 tenants → no cross-talk, no lost updates (extends the sq-06 stress
    approach).
  - Path-traversal tenant id (`../x`) rejected by `resolve`.

#### MT-05 — Admin CRUD HTTP endpoints

- **Scoping:** After MT-03 (needs the registry). MT-06 follows MT-05.
- **Model:** **Sonnet.** CRUD over the registry behind the existing admin-token pattern.
- **Owns:** the admin route surface — `platform/server.ts` `/admin/*` section today, or `platform/http/*` if
  item 22 has landed (builder checks and targets whichever exists; exactly one).
- **Reads:** `platform/tenants/registry.ts`, `platform/server.ts`.
- **Work:** `POST /admin/tenants` (create, returns api key once), `GET /admin/tenants`,
  `GET /admin/tenants/:id`, `PATCH /admin/tenants/:id` (name/status), `DELETE /admin/tenants/:id` (soft →
  deactivate), `POST /admin/tenants/:id/keys` (issue), `DELETE /admin/tenants/:id/keys/:keyId` (revoke). All
  behind the existing `ADMIN_TOKEN` bearer check.
- **Acceptance criteria:**
  - `curl` each endpoint: 200s with valid admin token, 401 without.
  - `POST /admin/tenants` response contains the plaintext key exactly once; a second `GET` never does.

#### MT-06 — Admin CLI (`scripts/tenants.ts`)

- **Scoping:** After MT-05 (dogfoods its endpoints).
- **Model:** **Sonnet.** Small CLI, checkable by running.
- **Owns:** `scripts/tenants.ts`.
- **Reads:** MT-05's routes.
- **Work:** `deno run -A scripts/tenants.ts create <name> [--slug]`, `list`, `show <id>`, `deactivate <id>`,
  `issue-key <id> [--name]`, `revoke-key <key-id>`; talks to the admin endpoints using `ADMIN_TOKEN` env;
  table output; prints the API key once on create/issue-key with a "save this" warning.
- **Acceptance criteria:**
  - Full cycle against a live server: create → key works on `/apps/*`; revoke-key → key 401s; deactivate → all
    keys 401.

#### MT-07 — Tenant resolution in the request path + TS client tenant config

- **Scoping:** After MT-04 (needs routing). MT-08 follows MT-07.
- **Model:** **Opus.** Security-critical: the tenant-context seam every request flows through.
- **Owns:** `platform/http/auth.ts` (new; or the auth section of `platform/server.ts` if item 22 hasn't landed
  — builder checks), `sdk/client.ts` (docs + `createTenantClient` alias only, no behavior change).
- **Reads:** `platform/tenants/registry.ts`, `platform/tenants/routing.ts`, `sdk/client.ts`.
- **Work:**
  1. Request middleware: extract `Authorization: Bearer <key>` → `SHA-256` →
     `TenantRegistry.resolveTenantByKeyHash` (with a short TTL cache) → inject `TenantContext { tenantId }`
     into the Effect layer. Every `Storage` access resolves through it.
  2. **Never trust client tenant identity:** ignore (and log at warn) any `x-tenant-id` header or tenant field
     in the body — the credential is the single source of truth (§2.1).
  3. `sdk/client.ts`: document that `token` is now the tenant API key; add
     `createTenantClient(baseURL, appId, apiKey)` as a named alias for discoverability. No wire-format change.
- **Acceptance criteria:**
  - Tenant A's key reading tenant B's document id returns not-found (indistinguishable from missing) — test
    with two CLI-created tenants.
  - Missing/invalid key → 401; revoked key → 401.
  - A request carrying a forged `x-tenant-id` is still scoped to the key's tenant (test asserts this).

#### MT-08 — Better Auth email/password, headless

- **Scoping:** After MT-07 (needs the tenant-context seam). The plan's last item.
- **Model:** **Opus.** Auth is a security boundary; the spike needs judgment.
- **Owns:** `platform/auth/*`, `scripts/auth.ts` (admin user commands).
- **Reads:** `platform/tenants/registry.ts`, MT-07's middleware, Better Auth docs.
- **Work:**
  1. **SPIKE FIRST (go/no-go):** mount
     `betterAuth({ database: <pg>, emailAndPassword: { enabled: true, requireEmailVerification: false } }).handler`
     at `/api/auth/*`; from a Deno script, `createAuthClient` (vanilla `better-auth/client`) → `signUp.email`
     → `signIn.email` → capture the session token → call a tenant endpoint with it. **If the token cannot be
     captured and used headlessly, STOP:** close the item as headless-infeasible, document API-keys as the
     auth story, and do not proceed to step 2.
  2. If the spike passes: Better Auth tables in Postgres (via `auth generate`/`migrate`); users↔tenants
     membership (`memberships(user_id, tenant_id, role)`); extend MT-07's middleware to accept session tokens
     (session → user → tenant); `scripts/auth.ts`: `users create <email> [--tenant]`,
     `users link <email> <tenant>`.
- **Acceptance criteria:**
  - Headless sign-up/sign-in round-trip from a Deno script, exit 0.
  - Session token authenticates tenant-scoped requests; wrong password → 401; unknown user → 401.
  - If spiked infeasible: the spike script and a `docs.md`-style note recording the failure mode and the
    API-keys fallback (no silent punt).

#### MT-09 — Property tests for tenant routing invariants

- **Scoping:** After MT-03 and MT-04 (needs the registry and `TenantStorageRouter` interfaces). Batch MT-E.
- **Model:** **Sonnet.** Bounded, mechanical, checked by running.
- **Owns:** `tests/property/tenant_routing_props.ts` (new file only — disjoint from MT-04's
  `tests/unit/tenant_routing_test.ts`).
- **Reads:** `platform/tenants/routing.ts`, `platform/tenants/registry.ts`, `core/errors.ts`,
  `tests/property/arbitraries.ts` (seed harness), `work-scripts/deno/tx-conflict-stress.ts` (sq-06
  concurrent-load approach).
- **Work:**
  1. **Seed-replay pattern (reuse the item-12/13 convention):** import the seed harness from
     `tests/property/arbitraries.ts` — `PROP_SEED` env var → `fc.configureGlobal({ seed, numRuns })`,
     `titled()` suffixes every test name with `[seed=..., runs=...]` so the seed appears in `deno test`
     output. A failure therefore prints the shrunk counterexample AND the seed; re-running with
     `PROP_SEED=<n>` reproduces the exact failing case. Do not invent a second seed mechanism.
  2. **Arbitraries:** tenant ids (valid uuids), malformed ids (`../x`, separators, unicode, empty strings),
     registry states per tenant (active/deactivated/unknown), doc ids, op sequences (put/get/del).
  3. **Properties over the router + registry seam:**
     - **Isolation:** for arbitrary distinct tenant ids `a ≠ b`, `resolve(a)` and `resolve(b)` never produce
       the same `StorageLocation.path`.
     - **Determinism:** `resolve(id)` called twice yields deep-equal locations.
     - **Traversal impossibility:** for arbitrary string ids, `resolve` either returns a typed `TenantError`
       (`MalformedTenantId`) or a path strictly contained in `tenantsDir` after normalization — it never
       throws, and no produced path escapes the tenants dir.
     - **Registry-state gating (composed):** with a stub registry holding arbitrary per-tenant states, the
       `authorize → resolve → prepare` path yields typed `UnknownTenant`/`TenantDeactivated` errors for
       unknown/deactivated tenants and correct locations for active ones.
     - **Concurrent multi-tenant load (extends the sq-06 approach):** arbitrary tenant sets × concurrent
       put/get op sequences run in parallel; each tenant's reads see exactly its own writes — no cross-talk,
       no lost updates, and every write lands in the right tenant's file.
  4. `numRuns >= 200` per property, following the repo convention.
- **Acceptance criteria:**
  - `deno task test:prop` passes and includes the new file (it matches the existing `tests/property/**/*.ts`
    glob).
  - Each property's test name prints its seed (`[seed=...]` in `deno test` output).
  - Seed replay: deliberately breaking one invariant (e.g. making `resolve` return a constant path) makes the
    suite fail with a minimal counterexample; `PROP_SEED=<the printed seed> deno task test:prop` reproduces
    the exact same failure.
  - `deno task test:prop` completes in under 60 s on this droplet.

## 4. Out of scope / deferred

- Postgres HA, PITR, managed migrations beyond `schema.sql` + `make db-migrate`.
- Per-tenant DuckDB/event-log separation (tenants share the central event log in this phase; tenant id is a
  column).
- Billing, plans, quotas.
- OAuth/social providers (Better Auth supports them; not in this phase).
- If MT-08's spike fails: full user auth defers to a later phase; API keys remain the identity story.
