/** Real Postgres regression suite; every run owns and drops a unique scratch schema. */
import assert from "node:assert/strict";
import { Effect, Either, Layer } from "effect";
import postgres from "npm:postgres@3.4.9";
import { createAuthClient } from "npm:better-auth@1.7.7/client";
import { ConfigLive, ConfigTest } from "../config.ts";
import { Config, TenantRegistry } from "../services.ts";
import { makeTenantRegistry } from "../tenants/store.ts";
import { parseTenantId } from "../tenants/registry.ts";
import { resolveRequestTenant } from "../http/auth.ts";
import { handle } from "../http/router.ts";
import { EventSinkTest, IdGenTest } from "../../tests/layers/index.ts";
import { AuthAdapterError, postgresAdapter } from "./adapter.ts";

Deno.test("MT-08: headless auth, membership isolation, expiry, revocation and adapter transactions", async () => {
  const config = await Effect.runPromise(Config.pipe(Effect.provide(ConfigLive)));
  const schema = "mt08_test_" + crypto.randomUUID().replaceAll("-", "");
  const admin = postgres(config.tenancy.databaseUrl, { max: 1, onnotice() {} });
  await admin.unsafe('CREATE SCHEMA "' + schema + '"');
  const url = new URL(config.tenancy.databaseUrl);
  url.searchParams.set("options", "-c search_path=" + schema);
  const sql = postgres(url.toString(), { max: 2, onnotice() {} });
  let server: Deno.HttpServer | undefined;
  const fixture = await Deno.makeTempDir({ prefix: "mt08-migrations-" });
  try {
    // Exercise the repository's runner unchanged except for fixture file/import locations.
    const migrations = fixture + "/migrations/";
    await Deno.mkdir(migrations);
    for (const direction of ["up", "down"]) {
      await Deno.copyFile(
        new URL("../tenants/migrations/001_baseline." + direction + ".sql", import.meta.url),
        migrations + "001_baseline." + direction + ".sql",
      );
      await Deno.copyFile(
        new URL("./002_auth." + direction + ".sql", import.meta.url),
        migrations + "002_auth." + direction + ".sql",
      );
    }
    const runnerSource = await Deno.readTextFile(new URL("../../scripts/db/migrate.ts", import.meta.url));
    const runner = runnerSource
      .replace('"../../platform/config.ts"', JSON.stringify(new URL("../config.ts", import.meta.url).href))
      .replace(
        '"../../platform/services.ts"',
        JSON.stringify(new URL("../services.ts", import.meta.url).href),
      )
      .replace(
        'new URL("../../platform/tenants/migrations/", import.meta.url)',
        "new URL(" + JSON.stringify("file://" + migrations) + ")",
      );
    await Deno.writeTextFile(fixture + "/runner.ts", runner);
    const migrate = async (...args: string[]) =>
      await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-lock",
          "--config",
          new URL("../../deno.json", import.meta.url).pathname,
          fixture + "/runner.ts",
          ...args,
        ],
        env: { DATABASE_URL: url.toString() },
        stdout: "piped",
        stderr: "piped",
      }).output();
    assert.equal((await migrate()).code, 0);
    assert.deepEqual(
      (await sql`SELECT version FROM schema_migrations ORDER BY version`).map((row) => row.version),
      ["001", "002"],
    );
    assert.equal((await migrate()).code, 0, "migration replay is a no-op");
    assert.equal((await migrate("down")).code, 0, "empty auth migration rolls back");
    assert.equal((await migrate()).code, 0, "auth migration re-applies");
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    const baseURL = "http://127.0.0.1:" + port;
    const tenancy = {
      ...config.tenancy,
      mode: "better-auth" as const,
      databaseUrl: url.toString(),
      betterAuthSecret: crypto.randomUUID() + crypto.randomUUID(),
      betterAuthUrl: baseURL,
    };
    const registry = makeTenantRegistry(sql);
    const configLayer = ConfigTest({ tenancy, server: { maxRequestBytes: 1024 } });
    const layer = Layer.mergeAll(configLayer, EventSinkTest, IdGenTest);
    const resolve = (headers: Headers) =>
      resolveRequestTenant(headers, "test").pipe(
        Effect.provideService(TenantRegistry, registry),
        Effect.provide(configLayer),
      );
    server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
      if (new URL(request.url).pathname.startsWith("/api/auth/")) {
        // The real router only asks for Config/EventSink/IdGen on this route.
        return await Effect.runPromise(
          handle(request).pipe(Effect.provide(layer)) as Effect.Effect<Response>,
        );
      }
      const result = await Effect.runPromise(Effect.either(resolve(request.headers)));
      return Either.isRight(result)
        ? Response.json({ tenant: result.right })
        : new Response(null, { status: result.left._tag === "AuthError" ? 401 : 500 });
    });
    let cookie = "";
    const client = createAuthClient({
      baseURL,
      fetchOptions: {
        onSuccess(context) {
          const sessionCookie = context.response.headers.getSetCookie()
            .find((value) => value.startsWith("better-auth.session_token="));
          if (sessionCookie) cookie = sessionCookie.split(";")[0];
        },
      },
    });
    const tooLarge = await fetch(baseURL + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1025),
    });
    assert.equal(tooLarge.status, 413);
    await tooLarge.body?.cancel();
    const malformed = await fetch(baseURL + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    await malformed.body?.cancel();
    const email = "auth@example.test";
    const password = crypto.randomUUID();
    const signup = await client.signUp.email({ email, password, name: "Auth" });
    assert.equal(signup.error, null);
    const userId = signup.data!.user.id;
    assert.equal((await migrate("down")).code, 1, "nonempty auth migration cannot be rolled back");
    assert.equal((await sql`SELECT version FROM schema_migrations WHERE version='002'`).length, 1);
    const signin = await client.signIn.email({ email, password });
    assert.equal(signin.error, null);
    const token = signin.data!.token;
    assert.ok(token);
    const headers = new Headers({ authorization: "Bearer " + token });
    const request = async (h = headers) => {
      const response = await fetch(baseURL + "/tenant", { headers: h });
      const body = await response.text();
      return { status: response.status, body };
    };
    assert.equal((await request()).status, 401, "unlinked user");
    const a = await Effect.runPromise(registry.createTenant({ slug: "a", name: "A" }));
    const b = await Effect.runPromise(registry.createTenant({ slug: "b", name: "B" }));
    await sql`INSERT INTO memberships VALUES (${userId}, ${a.id}, 'member')`;
    assert.deepEqual(await request(), { status: 200, body: JSON.stringify({ tenant: a.id }) });
    headers.set("x-tenant-id", b.id);
    assert.equal(JSON.parse((await request()).body).tenant, a.id, "caller cannot choose tenant");
    headers.delete("x-tenant-id");
    const key = await Effect.runPromise(registry.issueApiKey(a.id, "test"));
    assert.equal((await request(new Headers({ authorization: "Bearer " + key.plaintext }))).status, 200);
    await sql`INSERT INTO memberships VALUES (${userId}, ${b.id}, 'member')`;
    assert.equal((await request()).status, 401, "ambiguous membership");
    await sql`DELETE FROM memberships WHERE tenant_id=${b.id}`;
    await Effect.runPromise(registry.deactivateTenant(a.id));
    assert.equal((await request()).status, 401, "inactive tenant");
    await Effect.runPromise(registry.updateTenant(a.id, { status: "active" }));
    assert.equal((await request()).status, 200);
    await sql`UPDATE session SET "expiresAt"=now()-interval '1 day' WHERE token=${token}`;
    assert.equal((await request()).status, 401, "expired session");
    const second = await client.signIn.email({ email, password });
    assert.equal(second.error, null);
    headers.set("authorization", "Bearer " + second.data!.token);
    assert.equal((await request()).status, 200);
    assert.ok(cookie.includes("="), "signed cookie captured for precedence test");
    assert.equal(
      (await request(new Headers({ authorization: "Bearer invalid", cookie }))).status,
      401,
      "valid ambient cookie cannot rescue invalid bearer",
    );
    assert.equal((await request(new Headers({ cookie }))).status, 401, "tenant routes require bearer");
    await client.signOut({ fetchOptions: { headers: { authorization: headers.get("authorization")! } } });
    assert.equal((await request()).status, 401, "sign-out revokes immediately");
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    for (const body of [{ email, password: "wrong-password" }, { email: "unknown@example.test", password }]) {
      assert.equal((await client.signIn.email(body)).error?.status, 401);
    }
    const invalid = new Headers({
      authorization: "Bearer invalid",
      cookie: "better-auth.session_token=invalid",
    });
    assert.equal((await request(invalid)).status, 401);
    assert.equal((await request(new Headers())).status, 401);
    await sql`ALTER TABLE session RENAME TO unavailable_session`;
    try {
      assert.equal((await request()).status, 500, "database failure is not an authentication miss");
    } finally {
      await sql`ALTER TABLE unavailable_session RENAME TO session`;
    }
    const cli = async (args: string[], secret?: string) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-lock", "scripts/auth.ts", ...args],
        env: {
          TENANCY: "better-auth",
          DATABASE_URL: url.toString(),
          BETTER_AUTH_SECRET: tenancy.betterAuthSecret,
          BETTER_AUTH_URL: baseURL,
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      if (secret !== undefined) await writer.write(new TextEncoder().encode(secret + "\n"));
      await writer.close();
      const result = await child.output();
      assert.ok(!new TextDecoder().decode(result.stdout).includes(password), "CLI must not print secrets");
      return result.code;
    };
    assert.equal(await cli(["users", "create", "cli@example.test", "--tenant", a.id], password), 0);
    assert.equal(await cli(["users", "link", "cli@example.test", a.id]), 0);
    const cliMembership = await sql`
      SELECT m.* FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE u.email='cli@example.test'
    `;
    assert.equal(cliMembership.length, 1);
    assert.equal(cliMembership[0].tenant_id, a.id);
    assert.equal(
      (await sql`
      SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email='cli@example.test'
    `).length,
      0,
      "CLI leaves no unused login session",
    );
    assert.equal(
      await cli(["users", "create", "fail@example.test", "--tenant", crypto.randomUUID()], password),
      1,
    );
    assert.equal((await sql`SELECT id FROM "user" WHERE email='fail@example.test'`).length, 0);
    // The adapter transaction must roll back account/user writes together.
    const adapter = postgresAdapter(sql)({});
    await assert.rejects(adapter.transaction(async (tx) => {
      await tx.create({
        model: "user",
        data: {
          name: "Rollback",
          email: "rollback@example.test",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      throw new AuthAdapterError({ detail: "rollback" });
    }));
    assert.equal((await sql`SELECT id FROM "user" WHERE email='rollback@example.test'`).length, 0);
    const grouped = await adapter.findMany<{ email: string }>({
      model: "user",
      where: [
        { field: "email", operator: "ne", value: email },
        { field: "email", value: email, connector: "OR" },
        { field: "email", value: "cli@example.test", connector: "OR" },
      ],
    });
    assert.deepEqual(grouped.map((row) => row.email), ["cli@example.test"], "AND guard intersects OR group");
    assert.equal(
      await adapter.findOne({
        model: "user",
        where: [
          { field: "email", value: "' OR 1=1--" },
        ],
      }),
      null,
      "predicate values cannot become SQL",
    );
    const verification = await adapter.create<{ id: string }>({
      model: "verification",
      data: {
        identifier: "single-use",
        value: "test",
        expiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const consumed = await Promise.all([1, 2].map(() =>
      adapter.consumeOne({
        model: "verification",
        where: [{ field: "id", value: verification.id }],
      })
    ));
    assert.equal(consumed.filter(Boolean).length, 1, "single-use consumption is atomic");
    await assert.rejects(adapter.findOne({ model: 'user"; DROP TABLE tenants;--', where: [] }));
    assert.ok(await Effect.runPromise(registry.getTenant(Effect.runSync(parseTenantId(a.id)))));
  } finally {
    await server?.shutdown();
    await sql.end();
    await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
    await Deno.remove(fixture, { recursive: true });
  }
});
