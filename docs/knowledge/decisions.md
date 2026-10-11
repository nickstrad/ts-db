# Architectural decisions

Dated decisions with rationale. Plans carry the _what_; this page carries the _why_. Newest first.

## 2026-10-11 — No ORM for Postgres access

Human decision: MT-03 (and any other item touching Postgres) uses the pinned `npm:postgres` client directly
with hand-written SQL, leveraging SQL syntax — not an ORM or query builder generating SQL internally.
Rationale: direct hand-written SQL is tunable and has no hidden query generation. Recorded in
`docs/plans/multitenancy.md` §2.4 and MT-03.

## 2026-10-11 — Knowledge lives in plain markdown, no `kb` CLI

Human decision: `docs/knowledge/` is markdown with `index.md`, deliberately not the nickstrad/kb full-text
store that `vm-agent` and `perpetual` use. Rationale: zero tooling means any agent (or the human in a text
editor) can read and update entries; nothing to build, index, or reindex.

## 2026-10-11 — Model tier mapping (dual-company)

Sessions run only on Claude or Codex, so every plan item pairs one model per company under a fixed
correspondence: Opus 5.5 ↔ Astra (`gpt-6-astra`) for the difficult items and all reviews; Sonnet ↔ Sol
(`gpt-6.1-sol`) for the middle tier; Haiku ↔ Luna (`gpt-6-luna`, high effort) for the fast tier.
`claude
--model haiku` resolves to `claude-haiku-5-5` (verified 2026-10-11); Haiku ≤4.5 must never be used —
the 4.5 experiment showed it drops safety-critical details and rates itself 5/5 regardless. Canonical source:
repo `AGENTS.md`.

## 2026-10-11 — Multitenancy: Postgres registry, per-tenant SQLite, router interface

`docs/plans/multitenancy.md` (MT-01–MT-10): Postgres is the central tenant registry; each tenant gets its own
SQLite file. Routing is a `TenantStorageRouter` Effect interface the Storage service depends on — never paths
or env vars. `LocalFolderRouter` maps UUID-validated tenants to `TENANTS_DIR/<tenant-id>.db`; a future
`ControlPlaneRouter` must be swappable with zero Storage/client changes. Rationale: grow from local folder to
control plane without rewriting the storage layer.

## 2026-10-11 — Better Auth is not punted

The multitenancy plan opens its auth item (MT-08) with a headless session-token go/no-go spike instead of
deferring auth. Side quest sq-09 proved it viable (better-auth 1.7.7 on Deno 2.9.5 against scratch Postgres:
signup → signin → authenticated 200). Open design point from Opus review: decide token transport before MT-08
builds — `bearer()` plugin if middleware takes `Authorization: Bearer`, else forward the cookie.

## 2026-10-10 — `PROP_SEED` seed-replay convention

Property tests print their failing seed; re-run exactly with `PROP_SEED=<n>`. Coverage assertions and
correctness assertions are reported separately so a coverage miss is never triaged as an invariant break
(lesson from sq-11: every lx-01 "flake" was a coverage assertion, zero invariant defects).

## 2026-10-10 — `work-scripts/` library

The human wants work scripts kept: anything an agent writes to investigate, measure, or verify goes in
`work-scripts/` (`deno/` for larger work, `bash/` for bash-oriented things), committed and indexed in
`work-scripts/INDEX.md` (one row per script: purpose, usage, notes). Rationale, proven 2026-10-11: every
side-quest review verdict could be independently re-run in minutes _because_ the scripts, raw data, and index
rows were on the branches.

## 2026-10-10 — Effect port as the architecture

Item 22: the entire server composes as a scoped Effect layer — partial-startup release, shutdown ordering,
ingest-then-sweep RPC triggering. Storage (item 15), DuckDB reader (item 16), object store (item 18), backups
(item 19) are all Effect services. Rationale: typed errors, supervised fibers, and composition replace ad-hoc
lifecycle code.

## 2026-10-10 — SQLite storage, DuckDB analytics, Deno runtime

The MVP's core shape survived the Effect port: SQLite for document storage, DuckDB for the query/analytics
plane, Deno as the runtime. The reflection pass (Astra, 2026-10-11) confirmed the core architecture sound
while sending back data-semantics fixes (items 30–37).

## Standing — Review and landing protocol

Every real plan item gets an independent top-tier review (Opus 5.5 or Astra, a different agent from the
builder) before landing. Nothing merges without Opus review **and** human approval. Landings are reported as
"item N landed and it now gives ability to do \<capability\>".

## 2026-10-11 — Shared agent event inbox, batched Git archive

Agent sessions across linked worktrees need one live log without concurrent index writes. The
[event-log design](../../agent-work/event-log.md) uses Git's common directory for immutable live events and
tracked `agent-work/events/` for coordinator-batched snapshots. Per-event publication uses an atomic hard
link; writers never commit. This is coordination infrastructure, separate from the product's event log.

## 2026-10-11 — MT-08 headless transport and PostgreSQL driver

The mandatory Deno vanilla-client spike passed against Better Auth 1.7.7 and Postgres 17: sign-up, sign-in,
capture the response body token, authenticate a tenant endpoint. The body token returns 401 without the bearer
plugin and authenticates with it, so tenant requests use `Authorization: Bearer <token>` with
`plugins: [bearer()]`. Cookies are not forwarded by tenant middleware.

The pinned built-in PostgreSQL path requires a `pg.Pool`-compatible object, not a raw postgres.js client. To
retain the no-ORM/handwritten-SQL rule, runtime uses Better Auth's minimal entrypoint and a custom adapter
over `npm:postgres@3.4.9`. Only the isolated schema-capture spike uses `pg@8.23.1` with the upstream migration
tooling. Production schema changes remain numbered SQL migrations in the normal `schema_migrations` journal.
This adapter is intentionally limited to the configured core auth models; future plugins/upgrades need adapter
and schema validation.

Membership resolution fails closed unless the user has exactly one membership and that tenant is active. No
client tenant selector is trusted. Auth database handles are owned and closed per request; sharing a pool
requires a future scoped-layer change. See [MT-08 implementation notes](../../platform/auth/README.md) for
executable verification, the generated schema, and operational limits.
