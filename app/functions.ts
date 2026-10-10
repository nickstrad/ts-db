// Application code: no SQL, database drivers, file paths, or storage-mode branches.
import { defineFunctions } from "../sdk/functions.ts";
import { v } from "../sdk/schema.ts";
import { schema } from "./schema.ts";
const { query, mutation } = defineFunctions(schema);
const lines = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
];

export const functions = {
  createGame: mutation({
    args: { xPlayer: v.string(), oPlayer: v.string() },
    async handler({ db }, { xPlayer, oPlayer }) {
      if (!xPlayer.trim() || !oPlayer.trim() || xPlayer === oPlayer) {
        throw new Error("Provide two distinct players");
      }
      const gameId = await db.insert("games", {
        xPlayer, oPlayer, board: Array(9).fill(null),
        turn: "X", status: "playing", winner: null,
      });
      return { gameId };
    },
  }),

  makeMove: mutation({
    args: { gameId: v.string(), playerId: v.string(), cell: v.integer(), expectedVersion: v.integer() },
    async handler({ db }, { gameId, playerId, cell, expectedVersion }) {
      // Although this is a read, it uses SQLite because we're inside a mutation.
      const game = await db.get("games", gameId);
      if (!game) throw new Error("Game not found");
      if (game._version !== expectedVersion) throw new Error("Stale version; reload the game");
      if (game.status !== "playing") throw new Error("Game is over");
      const expectedPlayer = game.turn === "X" ? game.xPlayer : game.oPlayer;
      if (playerId !== expectedPlayer) throw new Error("Not your turn");
      if (cell < 0 || cell > 8 || game.board[cell] !== null) throw new Error("Invalid move");

      const board = [...game.board];
      board[cell] = game.turn;
      const won = lines.some(([a, b, c]) => board[a] === game.turn && board[b] === game.turn && board[c] === game.turn);
      const status = won ? "won" : board.every((x) => x !== null) ? "draw" : "playing";

      await db.patch("games", gameId, {
        board, status, winner: won ? game.turn : null,
        turn: game.turn === "X" ? "O" : "X",
      });
      await db.insert("moves", {
        gameId, playerId, mark: game.turn, cell,
        moveNumber: board.filter((x) => x !== null).length,
      });
      // Board update + move insertion + this read all share one SQLite transaction.
      return await db.get("games", gameId);
    },
  }),

  getGame: query({
    args: { gameId: v.string() },
    handler: ({ db }, { gameId }) => db.get("games", gameId),
  }),

  listGames: query({
    args: { status: v.enum("playing", "won", "draw") },
    handler: ({ db }, { status }) => db.find("games", { status })
      .sort("_creationTime", "desc").limit(20).collect(),
  }),

  moveHistory: query({
    args: { gameId: v.string() },
    handler: ({ db }, { gameId }) => db.find("moves", { gameId })
      .sort("moveNumber").limit(9).collect(),
  }),

  winsByMark: query({
    args: {},
    // Compiles to a filtered GROUP BY + COUNT in DuckDB, not JS aggregation.
    handler: ({ db }) => db.find("games", { status: "won" }).countBy("winner"),
  }),

  deleteGame: mutation({
    args: { gameId: v.string() },
    async handler({ db }, { gameId }) {
      if (!await db.get("games", gameId)) throw new Error("Game not found");
      for (const move of await db.find("moves", { gameId }).limit(9).collect()) {
        await db.delete("moves", move._id);
      }
      await db.delete("games", gameId);
      return { deleted: true };
    },
  }),
};
