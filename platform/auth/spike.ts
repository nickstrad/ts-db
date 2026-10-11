/**
 * MT-08 gate: vanilla client, body token, real PostgreSQL.
 * Uses a unique scratch schema and drops only that schema in finally.
 * Run: deno run -A platform/auth/spike.ts
 */
import { AuthAdapterError } from "./adapter.ts";
import { betterAuth } from "npm:better-auth@1.7.7";
import { createAuthClient } from "npm:better-auth@1.7.7/client";
import { bearer } from "npm:better-auth@1.7.7/plugins/bearer";
import { getMigrations } from "npm:better-auth@1.7.7/db/migration";
import pg from "npm:pg@8.23.1";
import postgres from "npm:postgres@3.4.9";
import { Effect } from "effect";
import { ConfigLive } from "../config.ts";
import { Config } from "../services.ts";

const config = await Effect.runPromise(Config.pipe(Effect.provide(ConfigLive)));
const schema = "mt08_spike_" + crypto.randomUUID().replaceAll("-", "");
const sql = postgres(config.tenancy.databaseUrl, { max: 1, onnotice() {} });
await sql.unsafe('CREATE SCHEMA "' + schema + '"');
const pool = new pg.Pool({
  connectionString: config.tenancy.databaseUrl,
  options: "-c search_path=" + schema,
});
let server: Deno.HttpServer | undefined;
try {
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const baseURL = "http://127.0.0.1:" + port;
  const options = {
    database: pool,
    secret,
    baseURL,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    logger: { disabled: true },
  } as const;
  const auth = betterAuth({ ...options, plugins: [bearer()] });
  const withoutBearer = betterAuth(options);
  const migrations = await getMigrations(auth.options);
  // Capture tooling output for the normal migration, never auto-migrate production.
  await Deno.writeTextFile("/tmp/mt08-auth-generated.sql", await migrations.compileMigrations());
  await migrations.runMigrations();
  await sql.unsafe(`CREATE TABLE "${schema}".memberships (
    user_id text NOT NULL REFERENCES "${schema}"."user"(id),
    tenant_id uuid NOT NULL, role text NOT NULL, PRIMARY KEY(user_id, tenant_id))`);
  const tenantId = crypto.randomUUID();
  server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/auth/")) return auth.handler(request);
    const session = await (path === "/without-bearer" ? withoutBearer : auth)
      .api.getSession({ headers: request.headers });
    if (!session) return new Response(null, { status: 401 });
    const rows = await sql.unsafe(
      'SELECT tenant_id FROM "' + schema + '".memberships WHERE user_id=$1',
      [session.user.id],
    );
    return rows.length === 1
      ? Response.json({ tenantId: rows[0].tenant_id })
      : new Response(null, { status: 401 });
  });
  const client = createAuthClient({ baseURL });
  const email = "spike@example.test";
  const password = crypto.randomUUID() + crypto.randomUUID();
  const signup = await client.signUp.email({ email, password, name: "Spike" });
  if (signup.error || !signup.data.user.id) throw new AuthAdapterError({ detail: "Sign-up failed" });
  await sql.unsafe('INSERT INTO "' + schema + '".memberships VALUES ($1,$2,$3)', [
    signup.data.user.id,
    tenantId,
    "member",
  ]);
  const signin = await client.signIn.email({ email, password });
  if (signin.error || !signin.data.token) throw new AuthAdapterError({ detail: "No headless session token" });
  const headers = { authorization: "Bearer " + signin.data.token };
  const response = await fetch(baseURL + "/tenant", { headers });
  if (response.status !== 200 || (await response.json()).tenantId !== tenantId) {
    throw new AuthAdapterError({ detail: "Tenant token round-trip failed" });
  }
  const negative = await fetch(baseURL + "/without-bearer", { headers });
  await negative.body?.cancel();
  if (negative.status !== 401) {
    throw new AuthAdapterError({ detail: "Expected rejection without bearer plugin" });
  }
  for (
    const input of [
      { email, password: "wrong-password" },
      { email: "unknown@example.test", password },
    ]
  ) {
    const result = await client.signIn.email(input);
    if (result.error?.status !== 401) {
      throw new AuthAdapterError({ detail: "Expected credential failure 401" });
    }
  }
  await Deno.stdout.write(new TextEncoder().encode(
    "GO: vanilla signUp/signIn, captured body token, tenant 200; without bearer, wrong password, unknown user 401\n",
  ));
} finally {
  await server?.shutdown();
  await pool.end();
  await sql.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
  await sql.end();
}
