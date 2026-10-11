/** Headless auth service. Resources are owned by a single request/CLI operation. */
import { betterAuth } from "npm:better-auth@1.7.7/minimal";
import { bearer } from "npm:better-auth@1.7.7/plugins/bearer";
import postgres, { type Sql, type TransactionSql } from "npm:postgres@3.4.9";
import { Effect } from "effect";
import { AuthError, StorageError } from "../../core/errors.ts";
import type { TenancyConfig } from "../services.ts";
import { parseTenantId } from "../tenants/registry.ts";
import { AuthAdapterError, postgresAdapter } from "./adapter.ts";

export function createAuth(sql: Sql | TransactionSql, config: TenancyConfig, inTransaction = false) {
  if (!config.betterAuthSecret || config.betterAuthSecret.length < 32) {
    throw new AuthAdapterError({ detail: "BETTER_AUTH_SECRET must contain at least 32 characters" });
  }
  return betterAuth({
    database: postgresAdapter(sql, inTransaction),
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [bearer()],
    session: { cookieCache: { enabled: false } },
    logger: { disabled: true },
    telemetry: { enabled: false },
    rateLimit: { enabled: true },
    // The router has no trusted peer address. Never trust caller-supplied forwarding headers.
    // Better Auth uses its shared per-path bucket when no client IP is available.
    advanced: { ipAddress: { ipAddressHeaders: [] } },
  });
}

export type AuthService = ReturnType<typeof createAuth>;

/** Bounded connections, no global pools, closed even after rejected authentication. */
export function withAuthDatabase<A>(
  config: TenancyConfig,
  run: (auth: AuthService, sql: Sql) => Promise<A>,
): Effect.Effect<A, StorageError> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => postgres(config.databaseUrl, { max: 1, connect_timeout: 10, onnotice() {} }),
      catch: () => new StorageError({ operation: "open", detail: "auth database unavailable" }),
    }),
    (sql) =>
      Effect.tryPromise({
        try: () => run(createAuth(sql, config), sql),
        catch: () => new StorageError({ operation: "select", detail: "auth operation failed" }),
      }),
    (sql) => Effect.promise(() => sql.end()),
  );
}

/**
 * Only the bearer is forwarded: an ambient cookie cannot rescue invalid Authorization.
 * No caller tenant selector is trusted. Multiple memberships fail closed.
 */
export function sessionTenant(config: TenancyConfig, token: string, appId: string) {
  const unauthorized = () => new AuthError({ scope: "app", appId, reason: "mismatch" });
  return Effect.gen(function* () {
    const id = yield* withAuthDatabase(config, async (auth, sql) => {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: "Bearer " + token }),
        query: { disableCookieCache: true },
      });
      if (!session) return null;
      const memberships = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM memberships WHERE user_id = ${session.user.id} LIMIT 2
      `;
      return memberships.length === 1 ? memberships[0].tenant_id : null;
    });
    if (id === null) return yield* unauthorized();
    return yield* parseTenantId(id).pipe(Effect.mapError(unauthorized));
  });
}
