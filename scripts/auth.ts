/**
 * Headless admin CLI. Passwords arrive on stdin, never argv or logs.
 * deno run -A scripts/auth.ts users create <email> [--tenant <uuid>]
 * deno run -A scripts/auth.ts users link <email> <uuid>
 */
import { Effect } from "effect";
import { ConfigLive } from "../platform/config.ts";
import { Config } from "../platform/services.ts";
import { createAuth, withAuthDatabase } from "../platform/auth/service.ts";
import { parseTenantId } from "../platform/tenants/registry.ts";

export async function main(args: string[], password?: string): Promise<void> {
  const [group, command, email, ...rest] = args;
  if (
    group !== "users" || !["create", "link"].includes(command) ||
    !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (command === "create" && !(rest.length === 0 || (rest.length === 2 && rest[0] === "--tenant"))) ||
    (command === "link" && rest.length !== 1)
  ) {
    throw new Error("usage: users create <email> [--tenant <uuid>] | users link <email> <uuid>");
  }
  const tenant = command === "link" ? rest[0] : rest[1];
  const tenantId = tenant === undefined ? undefined : await Effect.runPromise(parseTenantId(tenant));
  const config = await Effect.runPromise(Config.pipe(Effect.provide(ConfigLive)));
  if (config.tenancy.mode !== "better-auth") throw new Error("TENANCY=better-auth required");
  if (command === "create" && (password === undefined || password.length < 8 || password.length > 128)) {
    throw new Error("Provide an 8–128 character password as one line on stdin");
  }
  await Effect.runPromise(
    withAuthDatabase(config.tenancy, async (_auth, pool) =>
      await pool.begin(async (sql) => {
        const auth = createAuth(sql, config.tenancy, true);
        // Check tenant before creating credentials; never create or change tenant ownership from a request.
        if (tenantId !== undefined) {
          const tenants =
            await sql`SELECT id FROM tenants WHERE id=${tenantId} AND status='active' FOR SHARE`;
          if (!tenants.length) throw new Error("Tenant unavailable");
        }
        let userId: string;
        if (command === "create") {
          const result = await auth.api.signUpEmail({
            body: { email, name: email, password: password! },
          });
          userId = result.user.id;
          // CLI account creation does not leave an unused login session behind.
          await sql`DELETE FROM session WHERE "userId"=${userId}`;
        } else {
          const users = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email=${email.toLowerCase()}`;
          if (users.length !== 1) throw new Error("User unavailable");
          userId = users[0].id;
        }
        if (tenantId !== undefined) {
          const linked = await sql`
        INSERT INTO memberships (user_id, tenant_id, role)
        SELECT ${userId}, id, 'member' FROM tenants WHERE id=${tenantId} AND status='active'
        ON CONFLICT (user_id, tenant_id) DO UPDATE SET role=memberships.role RETURNING user_id
      `;
          if (!linked.length) throw new Error("Tenant unavailable");
        }
      })),
  );
  console.log(command === "create" ? "User created" : "User linked");
}

if (import.meta.main) {
  try {
    let password: string | undefined;
    if (Deno.args[0] === "users" && Deno.args[1] === "create") {
      // Read a bounded line. No terminal echo; automation should pipe a secret from its store.
      if (Deno.stdin.isTerminal()) {
        throw new Error("Pipe the password on stdin; terminal input is not accepted");
      }
      const bytes = new Uint8Array(1024);
      let length = 0;
      while (length < bytes.length) {
        const n = await Deno.stdin.read(bytes.subarray(length));
        if (n === null) break;
        length += n;
      }
      if (length === 0 || length === bytes.length) throw new Error("Invalid password input");
      password = new TextDecoder().decode(bytes.subarray(0, length)).replace(/\r?\n$/, "");
      if (password.includes("\n") || password.includes("\r")) throw new Error("Expected one password line");
    }
    await main(Deno.args, password);
  } catch {
    console.error(
      "Auth command failed. Check arguments, credentials, tenant state and database configuration.",
    );
    Deno.exitCode = 1;
  }
}
