// TEMPORARY SCAFFOLD for property-test experiment (item 12) — to be replaced by the real item 10 implementation. Do not build on this.

import type { Either } from "../core/schema.ts";
import { Left, Right } from "../core/schema.ts";
import { MoveError } from "../core/errors.ts";

export type Mark = "X" | "O" | null;
export type GameStatus = "playing" | "won" | "draw";
export type GameBody = {
  xPlayer: string;
  oPlayer: string;
  board: (Mark)[];
  turn: Mark;
  status: GameStatus;
  winner: Mark;
};

export type MoveBody = {
  gameId: string;
  playerId: string;
  mark: Mark;
  cell: number;
  moveNumber: number;
};

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function winner(board: (Mark)[]): Mark {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] !== null && board[a] === board[b] && board[b] === board[c]) {
      return board[a];
    }
  }
  return null;
}

export function applyMove(
  game: GameBody,
  playerId: string,
  cell: number,
): Either<MoveError, { game: GameBody; move: MoveBody }> {
  // Validate game is still playing
  if (game.status !== "playing") {
    return Left(new MoveError("Game is over"));
  }

  // Validate it's the player's turn
  const expectedPlayer = game.turn === "X" ? game.xPlayer : game.oPlayer;
  if (playerId !== expectedPlayer) {
    return Left(new MoveError("Not your turn"));
  }

  // Validate cell
  if (cell < 0 || cell > 8 || game.board[cell] !== null) {
    return Left(new MoveError("Invalid move"));
  }

  // Apply the move
  const board = [...game.board];
  board[cell] = game.turn;

  // Determine new status
  const won = winner(board) !== null;
  const isFull = board.every((x) => x !== null);
  const status: GameStatus = won ? "won" : isFull ? "draw" : "playing";

  const nextTurn = game.turn === "X" ? "O" : "X";
  const filledCount = board.filter((x) => x !== null).length;

  const updatedGame: GameBody = {
    ...game,
    board,
    status,
    winner: won ? game.turn : null,
    turn: status === "playing" ? nextTurn : game.turn,
  };

  const move: MoveBody = {
    gameId: "", // Will be filled by caller
    playerId,
    mark: game.turn,
    cell,
    moveNumber: filledCount,
  };

  return Right({ game: updatedGame, move });
}
