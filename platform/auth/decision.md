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
