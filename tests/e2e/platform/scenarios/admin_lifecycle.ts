import { ConfigTest } from "../../../../platform/config.ts";
import { Config } from "../../../../platform/services.ts";
import {
  apps,
  assert,
  cli,
  client,
  delay,
  Effect,
  play,
  request,
  scenarioDir,
  startServer,
  tenant,
  test,
} from "../harness.ts";
import { database } from "../postgres.ts";
import { moves } from "../seed.ts";

test("e2e/7-admin-lifecycle: issue, revoke, deactivate and secret-safe CLI output", () =>
  Effect.gen(function* () {
    const dir = yield* scenarioDir("admin_lifecycle");
    const url = yield* database("admin_lifecycle");
    const server = yield* startServer(dir, url, { TENANCY: "api-key" });
    // This baseline does not expose its optional TTL in OPTIONS (the live layer supplies a default).
    // Local CLI mutations invalidate synchronously, so without a configured TTL enforce 1 s.
    // When MT-02 supplies the option, ConfigTest derives its default from the same table.
    const config = yield* Config.pipe(Effect.provide(ConfigTest()));
    const ttl = config.tenancy.tenantKeyCacheTtlMs ?? 0;
    yield* Effect.promise(async () => {
      const first = await tenant(server, 10);
      for (const app of apps) await play(client(server, app, first.key), moves.X.slice(0, 1));
      const issue = await cli(server, "tenants", ["issue-key", first.id]);
      const keys = issue.stdout.match(/tsdb_[A-Za-z0-9_-]+/g) ?? [];
      assert.equal(keys.length, 1);
      assert.match(issue.stdout, /Save this API key now/);
      const second = keys[0];
      for (const app of apps) await play(client(server, app, second), moves.O.slice(0, 2));
      const status = async (key: string, app: string) =>
        (await request(server, `/apps/${app}/query/listGames`, { status: "playing" }, key)).status;
      const refused = async (key: string) => {
        for (const app of apps) {
          const end = Date.now() + ttl + 1_000;
          while (await status(key, app) !== 401) {
            assert.ok(Date.now() < end, "Credential still authorized beyond configured cache TTL + 1 s");
            await delay(25);
          }
        }
      };
      for (const command of [["list"], ["show", first.id]]) {
        const out = await cli(server, "tenants", command);
        assert.ok(!out.stdout.includes(first.key) && !out.stdout.includes(second));
        assert.doesNotMatch(out.stdout + out.stderr, /tsdb_[A-Za-z0-9_-]+/);
      }
      await cli(server, "tenants", ["revoke-key", first.keyId]);
      await refused(first.key);
      for (const app of apps) assert.equal(await status(second, app), 200);
      await cli(server, "tenants", ["deactivate", first.id]);
      await refused(first.key);
      await refused(second);
      const show = await cli(server, "tenants", ["show", first.id]);
      assert.match(show.stdout, /deactivated/);
      assert.doesNotMatch(show.stdout + show.stderr, /tsdb_[A-Za-z0-9_-]+/);
      const wrong = await cli(server, "tenants", ["list"], { ADMIN_TOKEN: "wrong" }, false);
      assert.notEqual(wrong.code, 0);
      assert.match(wrong.stderr, /401/);
    });
  }));
