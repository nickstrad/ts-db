/**
 * Request authentication (plan item 22, work 3): the per-app bearer token and the admin token, as
 * Effects failing with `AuthError` (→ 401 via `toHttpStatus`).
 *
 * This is the seam every routed request passes before its handler runs. A successful check yields a
 * `Principal`, and the router hands the handler nothing but that principal and the request — so a
 * later credential scheme (the multitenancy plan's MT-07 tenant API keys, MT-08 sessions) replaces
 * or extends `authenticateApp` and the principal it returns, and provides its `TenantContext` from
 * there, without touching routing or handlers.
 *
 * Behaviour kept from the pre-port server:
 * - The header must be exactly `Authorization: Bearer <token>`; anything else is a 401.
 * - App routes compare against the app's own token (`COLUMN_APP_TOKEN` / `JSON_APP_TOKEN`), admin
 *   routes against `ADMIN_TOKEN`. All three default to the documented `dev-only` token
 *   (README "Configuration"); `devTokensInUse` names the ones still on it, and `platform/server.ts`
 *   reports them at startup as one `lifecycle` warning, replacing the old unconditional stderr
 *   banner (item 08's hook, owned by item 22).
 *
 * New: comparison is constant-time in the token's bytes, and an `AuthError` never carries the
 * presented token — only which scope failed and why.
 */
import { Effect } from "effect";
import { AuthError } from "../../core/errors.ts";
import type { App, ConfigService } from "../services.ts";

/** The documented default for every token (`platform/config.ts`). */
export const DEV_TOKEN = "dev-only";

/** Who a request authenticated as. */
export type Principal =
  | { readonly scope: "app"; readonly appId: string }
  | { readonly scope: "admin" };

const encoder = new TextEncoder();

/**
 * Equality that does not stop at the first differing byte. Length still leaks (the loop runs over the
 * longer input); token lengths are not secret here.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

type BearerResult =
  | { readonly _tag: "token"; readonly token: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "malformed" };

/** Reads `Authorization: Bearer <token>`. The scheme is case-sensitive, as it was before the port. */
export function bearerToken(headers: Headers): BearerResult {
  const header = headers.get("authorization");
  if (header === null || header === "") return { _tag: "missing" };
  if (!header.startsWith("Bearer ") || header.length === "Bearer ".length) return { _tag: "malformed" };
  return { _tag: "token", token: header.slice("Bearer ".length) };
}

function check(
  headers: Headers,
  expected: string,
  fail: (reason: AuthError["reason"]) => AuthError,
): Effect.Effect<void, AuthError> {
  const presented = bearerToken(headers);
  if (presented._tag !== "token") return Effect.fail(fail(presented._tag));
  return constantTimeEqual(presented.token, expected) ? Effect.void : Effect.fail(fail("mismatch"));
}

/** `Bearer <app.token>`, or `AuthError({ scope: "app" })`. */
export function authenticateApp(headers: Headers, app: App): Effect.Effect<Principal, AuthError> {
  return Effect.as(
    check(headers, app.token, (reason) => new AuthError({ scope: "app", appId: app.id, reason })),
    { scope: "app", appId: app.id } as const,
  );
}

/** `Bearer <ADMIN_TOKEN>`, or `AuthError({ scope: "admin" })`. */
export function authenticateAdmin(
  headers: Headers,
  config: ConfigService,
): Effect.Effect<Principal, AuthError> {
  return Effect.as(
    check(headers, config.server.adminToken, (reason) => new AuthError({ scope: "admin", reason })),
    { scope: "admin" } as const,
  );
}

/**
 * Which configured tokens still hold the `dev-only` default, by env var. Empty in a configured
 * deployment; the server emits one `lifecycle` warning at startup when it is not.
 */
export function devTokensInUse(config: ConfigService): readonly string[] {
  const inUse: string[] = [];
  if (config.server.adminToken === DEV_TOKEN) inUse.push("ADMIN_TOKEN");
  for (const app of config.apps) {
    if (app.token === DEV_TOKEN) inUse.push(`token for ${app.id}`);
  }
  return inUse;
}
