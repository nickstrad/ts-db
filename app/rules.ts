/**
 * The tic-tac-toe rules, as pure functions (plan item 10, work 3).
 *
 * This module is PURE in the same sense as `core/`: it imports `effect` and types only — no
 * `Effect`, no `sdk/` runtime, no `platform/`, no `Deno.*`, no I/O. Every rejection is a
 * `MoveError` in the left channel of an `Either`, so the whole game can be exercised without a
 * database (`tests/unit/rules_test.ts`, and the property suite in item 12).
 *
 * Note on the type parameter order: the plan writes `applyMove`'s signature error-first
 * (`Either<MoveError, …>`), but Effect 3's `Either` is value-first — `Either<A, E>`. The code
 * below uses the real Effect order, as `core/schema.ts` does.
 *
 * The rules themselves are carried over from the pre-port `app/functions.ts` unchanged, including
 * the order in which they reject (game over, then turn ownership, then the cell) and the fact that
 * the turn flips even on the move that ends the game.
 */
import { Data, Either } from "effect";
import type { Body, Document } from "../sdk/schema.ts";
import type { schema } from "./schema.ts";

export type Game = Document<typeof schema, "games">;
export type GameBody = Body<typeof schema, "games">;
export type MoveBody = Body<typeof schema, "moves">;
export type Mark = GameBody["turn"];
export type Board = GameBody["board"];

/** Which rule rejected the request. `distinct-players` is `createGame`'s only rule. */
export type MoveFailure = "distinct-players" | "game-over" | "not-your-turn" | "invalid-move";

/**
 * An app-domain rule violation — the failures that used to read `throw new Error("Not your turn")`.
 *
 * It is declared here, not in `core/errors.ts`: the error taxonomy in `core/` belongs to the
 * platform, and the rules of a game belong to the app that defines them. `message` is a field
 * because a `Data.TaggedError` has no message of its own, and until item 22 renders tagged errors
 * into HTTP bodies the message is what `platform/server.ts` reports.
 */
export class MoveError extends Data.TaggedError("MoveError")<{
  readonly rule: MoveFailure;
  readonly message: string;
}> {}

/** The eight winning lines, in the order the pre-port handler checked them. */
export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** The mark holding a complete line, or `null` if no line is held. */
export function winner(board: Board): Mark | null {
  for (const [a, b, c] of LINES) {
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return mark;
  }
  return null;
}

/**
 * Plays `cell` for `playerId` on `game`, returning the complete next game body and the move to
 * record. Both are plain data: the caller decides how to persist them.
 *
 * `cell` is re-checked for integrality even though `v.integer()` already rejected non-integers at
 * the argument boundary, so that this function is total for any input a property test can invent.
 */
export function applyMove(
  game: Game,
  playerId: string,
  cell: number,
): Either.Either<{ game: GameBody; move: MoveBody }, MoveError> {
  if (game.status !== "playing") {
    return Either.left(new MoveError({ rule: "game-over", message: "Game is over" }));
  }
  const expectedPlayer = game.turn === "X" ? game.xPlayer : game.oPlayer;
  if (playerId !== expectedPlayer) {
    return Either.left(new MoveError({ rule: "not-your-turn", message: "Not your turn" }));
  }
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || game.board[cell] !== null) {
    return Either.left(new MoveError({ rule: "invalid-move", message: "Invalid move" }));
  }
  const board = [...game.board];
  board[cell] = game.turn;
  const champion = winner(board);
  const filled = board.filter((mark) => mark !== null).length;
  return Either.right({
    game: {
      xPlayer: game.xPlayer,
      oPlayer: game.oPlayer,
      board,
      // The turn flips even when the game ends; `status` is what stops further moves.
      turn: game.turn === "X" ? "O" : "X",
      status: champion ? "won" : filled === board.length ? "draw" : "playing",
      winner: champion,
    },
    move: { gameId: game._id, playerId, mark: game.turn, cell, moveNumber: filled },
  });
}
