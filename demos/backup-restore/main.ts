import { Effect } from "effect";
import type { functions } from "../../app/functions.ts";
import { createClient } from "../../sdk/client.ts";
import { assert, environment, post, run, server, temporaryRoot } from "./lifecycle.ts";

await run(
  "backup-restore",
  Effect.scoped(Effect.gen(function* () {
    const root = yield* temporaryRoot;
    const snapshot = yield* Effect.scoped(Effect.gen(function* () {
      const base = yield* server(root);
      const client = createClient<typeof functions>(base, "tic-tac-toe", "demo-app");
      const { gameId } = yield* client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
      const initial = yield* client.query("getGame", { gameId });
      assert(initial, "created game exists");
      const backedUp = yield* client.mutation("makeMove", {
        gameId,
        playerId: "alice",
        cell: 0,
        expectedVersion: initial._version,
      });
      assert(backedUp, "first move exists");
      const published = yield* post(base, "/admin/backup/tic-tac-toe");
      const manifest = yield* Effect.promise(async () => {
        const value = JSON.parse(
          await Deno.readTextFile(`${root}/object-store/apps/tic-tac-toe/latest.json`),
        );
        assert(value.format === 1 && value.appId === "tic-tac-toe", "latest manifest format and app");
        assert(
          value.key === published.key && value.sha256 === published.sha256,
          "latest manifest matches admin result",
        );
        const bytes = await Deno.readFile(`${root}/object-store/${value.key}`);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        assert(hash === value.sha256 && bytes.length === value.bytes, "backup SHA-256 and size verified");
        return value;
      });
      console.log(`Backup key: ${manifest.key}`);
      console.log(`SHA-256: ${manifest.sha256}`);
      const later = yield* client.mutation("makeMove", {
        gameId,
        playerId: "bob",
        cell: 3,
        expectedVersion: backedUp._version,
      });
      assert(later && later._version === backedUp._version + 1, "post-backup move increments version");
      console.log(
        `Backed-up version: ${backedUp._version}; live version after another move: ${later._version}`,
      );
      return { gameId, backedUp, later };
    })); // Release the first server before restore (including its reader and SQLite handles).
    yield* Effect.promise(async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "scripts/restore.ts", "tic-tac-toe", `${root}/restored/tic-tac-toe.sqlite`],
        clearEnv: true,
        env: environment(root),
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, `restore exits 0: ${new TextDecoder().decode(result.stderr)}`);
      console.log(new TextDecoder().decode(result.stdout).trim());
    });
    const restoredBase = yield* server(root, `${root}/restored`);
    const client = createClient<typeof functions>(restoredBase, "tic-tac-toe", "demo-app");
    const restored = yield* client.query("getGame", { gameId: snapshot.gameId });
    assert(
      restored && restored._version === snapshot.backedUp._version,
      "restored version equals backed-up version",
    );
    assert(restored._version !== snapshot.later._version, "post-backup move is absent after restore");
    assert(
      JSON.stringify(restored) === JSON.stringify(snapshot.backedUp),
      "restored document equals backed-up document",
    );
    const history = yield* client.query("moveHistory", { gameId: snapshot.gameId });
    assert(history.length === 1 && history[0].cell === 0, "restored history excludes post-backup move");
    console.log(
      `Restored version: ${restored._version}; post-backup version ${snapshot.later._version} is absent`,
    );
    console.log("Asynchronous backup, not high availability: writes after the snapshot are not restored");
  })),
);
