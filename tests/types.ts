// Compile-only checks. This function is never called.
import type { ReadDB, WriteDB } from "../sdk/db.ts";
import type { schema } from "../app/schema.ts";
import { createClient } from "../sdk/client.ts";
import type { functions } from "../app/functions.ts";
export function typeAssertions(read: ReadDB<typeof schema>, write: WriteDB<typeof schema>) {
  read.find("games", { status: "playing" }).sort("_creationTime");
  // @ts-expect-error queries cannot write
  read.insert("games", {});
  // @ts-expect-error unknown collection
  read.find("people");
  // @ts-expect-error misspelled enum
  read.find("games", { status: "playng" });
  // @ts-expect-error arrays are not scalar filters
  read.find("games", { board: [] });
  // @ts-expect-error metadata cannot be patched
  write.patch("games", "id", { _version: 99 });
  const client = createClient<typeof functions>("http://localhost:8000", "tic-tac-toe", "dev-only");
  client.query("getGame", { gameId: "id" });
  // @ts-expect-error mutation is not a query
  client.query("createGame", { xPlayer: "a", oPlayer: "b" });
  // @ts-expect-error cell must be numeric
  client.mutation("makeMove", { gameId: "id", playerId: "a", cell: "0", expectedVersion: 1 });
}
