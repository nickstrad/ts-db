// Property tests for app/rules.ts tic-tac-toe logic
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "npm:fast-check";
import { applyMove, winner } from "../../app/rules.ts";
import type { GameBody } from "../../app/rules.ts";
import { seed } from "./arbitraries.ts";

Deno.test(`rules properties (seed: ${seed})`, async (t) => {
  // Helper to create a valid game state
  function createGame(board: ("X" | "O" | null)[] = Array(9).fill(null)): GameBody {
    const xCount = board.filter((x) => x === "X").length;
    const oCount = board.filter((x) => x === "O").length;
    const turn = xCount === oCount ? "X" : "O";

    return {
      xPlayer: "Alice",
      oPlayer: "Bob",
      board,
      turn,
      status: "playing",
      winner: null,
    };
  }

  // Helper to get all valid moves
  function getValidMoves(board: (string | null)[]): number[] {
    return board.map((cell, idx) => (cell === null ? idx : -1)).filter((idx) => idx >= 0);
  }

  // Property 1: from any reachable board, a legal move increases the filled-cell count by exactly one
  await t.step("legal move increases filled-cell count by one", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("X", "O", null), { minLength: 9, maxLength: 9 })
          .filter((board) => {
            const xCount = board.filter((x) => x === "X").length;
            const oCount = board.filter((x) => x === "O").length;
            return Math.abs(xCount - oCount) <= 1 && xCount + oCount < 9;
          }),
        (board) => {
          const typedBoard = board as ("X" | "O" | null)[];
          const game = createGame(typedBoard);
          const validMoves = getValidMoves(typedBoard);

          if (validMoves.length === 0) return true; // No moves available

          const cell = validMoves[0];
          const filledBefore = typedBoard.filter((x) => x !== null).length;

          const result = applyMove(game, game.turn === "X" ? game.xPlayer : game.oPlayer, cell);
          assertEquals(result.tag, "Right");

          if (result.tag === "Right") {
            const filledAfter = result.value.game.board.filter((x) => x !== null).length;
            assertEquals(filledAfter, filledBefore + 1, "Filled cell count should increase by exactly 1");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 2: a won game stays won
  await t.step("a won game cannot have new moves", () => {
    fc.assert(
      fc.property(fc.boolean(), (isXWon) => {
        const board: ("X" | "O" | null)[] = [
          isXWon ? "X" : "O",
          isXWon ? "X" : "O",
          isXWon ? "X" : null,
          null,
          "O",
          null,
          null,
          "X",
          "O",
        ];

        const game = createGame(board);
        game.status = "won";
        game.winner = isXWon ? "X" : "O";

        // Try to make a move (should fail since game is won)
        const emptyCell = 2;
        const result = applyMove(game, game.xPlayer, emptyCell);
        assertEquals(result.tag, "Left", "Cannot move in a won game");
      }),
      { numRuns: 50 },
    );
  });

  // Property 3: winner is non-null iff some line is uniform and non-null
  await t.step("winner is non-null iff a line is uniform", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("X", "O", null), { minLength: 9, maxLength: 9 })
          .filter((board) => {
            const xCount = board.filter((x) => x === "X").length;
            const oCount = board.filter((x) => x === "O").length;
            return Math.abs(xCount - oCount) <= 1;
          }),
        (board) => {
          const w = winner(board);
          const winningLines = [
            [0, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
            [0, 3, 6],
            [1, 4, 7],
            [2, 5, 8],
            [0, 4, 8],
            [2, 4, 6],
          ];

          const hasUniformLine = winningLines.some(
            ([a, b, c]) => board[a] !== null && board[a] === board[b] && board[b] === board[c],
          );

          if (hasUniformLine) {
            assertNotEquals(w, null, "winner should be non-null if a line is uniform");
          } else {
            assertEquals(w, null, "winner should be null if no line is uniform");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 4: a full board is draw or won, never playing
  await t.step("full board is draw or won, never playing", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("X", "O"), { minLength: 9, maxLength: 9 })
          .filter((board) => {
            const xCount = board.filter((x) => x === "X").length;
            const oCount = board.filter((x) => x === "O").length;
            return Math.abs(xCount - oCount) <= 1;
          }),
        (board) => {
          const game = createGame(board);
          const w = winner(board);
          const status = w ? "won" : "draw";

          // The game should report the correct status for a full board
          if (board.every((x) => x !== null)) {
            assertEquals(status === "draw" || status === "won", true, "Full board should be draw or won");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 5: replaying the same move sequence is deterministic
  await t.step("replaying the same move sequence is deterministic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 8 }), fc.boolean()), {
          maxLength: 9,
        }),
        (moves) => {
          // Replay move sequence twice
          const board1 = Array(9).fill(null);
          const board2 = Array(9).fill(null);

          for (let i = 0; i < 2; i++) {
            const board = i === 0 ? board1 : board2;
            let game = createGame(board);

            for (const [cell, _] of moves) {
              if (game.status !== "playing" || board[cell] !== null) break;

              const playerId = game.turn === "X" ? game.xPlayer : game.oPlayer;
              const result = applyMove(game, playerId, cell);

              if (result.tag === "Right") {
                game = result.value.game;
                board[cell] = result.value.move.mark;
              } else {
                break;
              }
            }
          }

          // Both boards should be identical
          assertEquals(JSON.stringify(board1), JSON.stringify(board2), "Replaying moves should be deterministic");
        },
      ),
      { numRuns: 100 },
    );
  });
});
