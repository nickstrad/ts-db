// TEMPORARY BRIDGE (item 10): the Effect client's promise wrapper, until this file is ported.
import { createPromiseClient } from "../sdk/client.ts";
import type { functions } from "../app/functions.ts";
const base = Deno.env.get("BASE_URL") ?? "http://127.0.0.1:8000";
const app = Deno.args[0] ?? "tic-tac-toe";
const client = createPromiseClient<typeof functions>(base, app, Deno.env.get("TOKEN") ?? "dev-only");
const { gameId } = await client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
console.log("Created:", gameId);
let game = await client.query("getGame", { gameId });
for (const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const) {
  game = await client.mutation("makeMove", { gameId, playerId, cell, expectedVersion: game!._version });
}
console.log("Game:", await client.query("getGame", { gameId }));
console.log("Moves:", await client.query("moveHistory", { gameId }));
console.log("Wins:", await client.query("winsByMark", {}));
console.log("Won games:", await client.query("listGames", { status: "won" }));
