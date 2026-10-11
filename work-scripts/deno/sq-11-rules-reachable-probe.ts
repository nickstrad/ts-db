// sq-11 probe: why does rules_test.ts "generators: reachable states cover ... full boards" fail for some seeds?
//
// The generator (playersArb, orderArb, reachableArb, play, step, newGame) is a VERBATIM copy of
// tests/property/rules_test.ts (the test does not export it). The copy is checked: its verdict at each
// seed must match the real test's verdict, which is recorded in the findings file from `deno test` runs.
//
// Reports:
//   1. Per seed (1..200, or PROP_SEEDS): does the copy's 300-sample set contain a full-board draw?
//      Also the mid-game and won assertions, so any other failing assertion would show up.
//   2. Tally at PROP_SEED (default 21): requested move-order length x final status.
//   3. Measured length distribution of orderArb over 100k samples, and P(draw | length 9) measured.
//   4. Exact count of draws over all 9! move orders (enumerated, not sampled).
//
// Usage (from repo root):
//   deno run --allow-read --allow-env work-scripts/deno/sq-11-rules-reachable-probe.ts
//   PROP_SEED=21 PROP_SEEDS=1-200 deno run --allow-read --allow-env work-scripts/deno/sq-11-rules-reachable-probe.ts

import fc from "fast-check";
import { Either } from "effect";
import { applyMove, type Game, type Mark } from "../../app/rules.ts";

const NUM_RUNS = 300;
const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const filled = (board: readonly (Mark | null)[]): number => board.filter((c) => c !== null).length;

// --- verbatim from tests/property/rules_test.ts -----------------------------------------------------------
function newGame(xPlayer: string, oPlayer: string): Game {
  return {
    _id: "game-1",
    _creationTime: 1_700_000_000_000,
    _version: 1,
    xPlayer,
    oPlayer,
    board: Array(9).fill(null) as Game["board"],
    turn: "X",
    status: "playing",
    winner: null,
  };
}
const toMove = (g: Game): string => (g.turn === "X" ? g.xPlayer : g.oPlayer);
function step(game: Game, cell: number): Game | null {
  const result = applyMove(game, toMove(game), cell);
  if (Either.isLeft(result)) return null;
  return { ...game, ...result.right.game, _version: game._version + 1 };
}
function play(start: Game, order: readonly number[]): { game: Game; history: Game[] } {
  let game = start;
  const history: Game[] = [game];
  for (const cell of order) {
    if (game.status !== "playing") break;
    const next = step(game, cell);
    if (next === null) throw new Error(`legal move rejected: cell ${cell}`);
    game = next;
    history.push(game);
  }
  return { game, history };
}
const playersArb = fc.tuple(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.string({ minLength: 1, maxLength: 8 }),
)
  .filter(([x, o]) => x.trim() !== "" && o.trim() !== "" && x !== o);
const orderArb = fc.shuffledSubarray(CELLS, { minLength: 0, maxLength: 9 }).chain((cells) =>
  fc.shuffledSubarray(cells, { minLength: cells.length, maxLength: cells.length })
);
// --- end verbatim -----------------------------------------------------------------------------------------

// Same arbitrary as the test, but also returns the requested order. `map` consumes no extra randomness, so
// the games are identical to the test's `reachableArb` at every seed (checked below).
const probeArb = fc.tuple(playersArb, orderArb).map(([[x, o], order]) => ({
  order,
  ...play(newGame(x, o), order),
}));

// Candidate fix (sketch, measured here, NOT applied to tests/): half the samples draw a full permutation of
// the nine cells, so length 9 is no longer ~8% of samples. Every such order is still a legal play prefix.
const fullOrderArb = fc.shuffledSubarray(CELLS, { minLength: 9, maxLength: 9 });
const candidateOrderArb = fc.oneof(
  { weight: 1, arbitrary: orderArb },
  { weight: 1, arbitrary: fullOrderArb },
);
const candidateArb = fc.tuple(playersArb, candidateOrderArb).map(([[x, o], order]) => ({
  order,
  ...play(newGame(x, o), order),
}));

/** The test's three reachability assertions, evaluated on the copy's samples. */
function verdict(
  seed: number,
  arb: typeof probeArb | typeof candidateArb = probeArb,
): { midGame: boolean; won: boolean; fullDraw: boolean; states: Game[] } {
  const states = fc.sample(arb, { numRuns: NUM_RUNS, seed }).map((s) => s.game);
  return {
    midGame: states.some((g) => g.status === "playing" && filled(g.board) > 0),
    won: states.some((g) => g.status === "won"),
    fullDraw: states.some((g) => g.status === "draw" && filled(g.board) === 9),
    states,
  };
}

function parseSeeds(spec: string): number[] {
  const [a, b] = spec.split("-").map(Number);
  return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
}

// 1. Sweep ---------------------------------------------------------------------------------------------------
const seeds = parseSeeds(Deno.env.get("PROP_SEEDS") ?? "1-200");
for (
  const [label, arb] of [["current generator (rules_test.ts)", probeArb], [
    "candidate (sketch)",
    candidateArb,
  ]] as const
) {
  const failingFullDraw: number[] = [];
  const failingOther: number[] = [];
  for (const seed of seeds) {
    const v = verdict(seed, arb);
    if (!v.fullDraw) failingFullDraw.push(seed);
    if (!v.midGame || !v.won) failingOther.push(seed);
  }
  console.log(
    `sweep [${label}] seeds ${seeds[0]}..${seeds.at(-1)} (${seeds.length}), ${NUM_RUNS} samples/seed: ` +
      `no-full-board-draw at ${failingFullDraw.length} (${
        (failingFullDraw.length / seeds.length * 100).toFixed(1)
      }%)`,
  );
  console.log(
    `  seeds: ${failingFullDraw.slice(0, 40).join(", ")}${failingFullDraw.length > 40 ? ", ..." : ""}`,
  );
  console.log(
    `  other reachability assertions failing (midGame/won): ${
      failingOther.length ? failingOther.join(", ") : "none"
    }`,
  );
}

// 2. Tally at one seed ---------------------------------------------------------------------------------------
const tallySeed = Number(Deno.env.get("PROP_SEED") ?? 21);
const tallySamples = fc.sample(probeArb, { numRuns: NUM_RUNS, seed: tallySeed });
const table = new Map<string, number>();
for (const s of tallySamples) {
  const key = `${String(s.order.length).padStart(1)} ${s.game.status.padEnd(8)} filled=${
    filled(s.game.board)
  }`;
  table.set(key, (table.get(key) ?? 0) + 1);
}
console.log(`\ntally at PROP_SEED=${tallySeed} (${NUM_RUNS} samples): order-length, status, filled cells`);
for (const [key, n] of [...table].sort()) console.log(`  len ${key}  x${n}`);
const byLen = new Map<number, number>();
for (const s of tallySamples) byLen.set(s.order.length, (byLen.get(s.order.length) ?? 0) + 1);
console.log(
  `  requested-length histogram: ${
    JSON.stringify(Object.fromEntries([...byLen].sort((a, b) => a[0] - b[0])))
  }`,
);

// 3. Large-sample measurement of length and P(draw | 9) ------------------------------------------------------
const BIG = 100_000;
const big = fc.sample(probeArb, { numRuns: BIG, seed: 1 });
const len9 = big.filter((s) => s.order.length === 9);
const len9Draws = len9.filter((s) => s.game.status === "draw").length;
const bigDraws = big.filter((s) => s.game.status === "draw" && filled(s.game.board) === 9).length;
console.log(
  `\nmeasured over ${BIG} samples (seed 1); NOTE: fast-check's bias frequency depends on the run index\n  (runIdToFrequency, fast-check lib/fast-check.js:1122), so these rates are NOT those of the first 300 runs the\n  test sees; section 3b measures those:`,
);
console.log(`  P(order length = 9)            = ${(len9.length / BIG).toFixed(5)} (${len9.length})`);
console.log(
  `  P(draw | length 9)             = ${(len9Draws / len9.length).toFixed(5)} (${len9Draws}/${len9.length})`,
);
console.log(`  P(full-board draw per sample)  = ${(bigDraws / BIG).toFixed(5)} (${bigDraws})`);

// 3b. Per-seed count of full-board draws in the 300-sample set, for the current and the candidate generator.
//     Checks whether the per-seed counts are Poisson-like (the flake rate the test sees is then fixed by the mean).
for (const [label, arb] of [["current", probeArb], ["candidate", candidateArb]] as const) {
  const counts = new Map<number, number>();
  let totalSamples = 0;
  let totalLen9 = 0;
  let totalDraws = 0;
  for (const seed of seeds) {
    const samples = fc.sample(arb, { numRuns: NUM_RUNS, seed });
    let c = 0;
    for (const s of samples) {
      totalSamples++;
      if (s.order.length === 9) totalLen9++;
      if (s.game.status === "draw" && filled(s.game.board) === 9) {
        c++;
        totalDraws++;
      }
    }
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const mean = totalDraws / seeds.length;
  console.log(
    `\n[${label}] across ${seeds.length} seeds x ${NUM_RUNS} samples: P(len 9)=${
      (totalLen9 / totalSamples).toFixed(5)
    }, ` +
      `P(full-board draw/sample)=${(totalDraws / totalSamples).toFixed(5)}, mean draws/seed=${
        mean.toFixed(3)
      }`,
  );
  console.log(
    `  seeds by draws-in-300: ${JSON.stringify(Object.fromEntries([...counts].sort((a, b) => a[0] - b[0])))}`,
  );
  console.log(
    `  Poisson(${mean.toFixed(3)}) P(0) = ${Math.exp(-mean).toFixed(4)}; observed P(0) = ${
      ((counts.get(0) ?? 0) / seeds.length).toFixed(4)
    }`,
  );
}

// 4. Exact enumeration of all 9! move orders ----------------------------------------------------------------
let draws = 0;
let won = 0;
let total = 0;
const permute = (prefix: number[], rest: number[]): void => {
  if (rest.length === 0) {
    total++;
    const { game } = play(newGame("x", "o"), prefix);
    if (game.status === "draw") draws++;
    else if (game.status === "won") won++;
    return;
  }
  for (let i = 0; i < rest.length; i++) {
    permute([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
  }
};
permute([], CELLS);
console.log(`\nexact over all permutations of 9 cells (${total}):`);
console.log(`  draws (full board, no line) = ${draws}  -> ${(draws / total).toFixed(5)} of length-9 orders`);
console.log(`  won before move 9           = ${won}`);

// 5. Anchor: a hand-picked full-board draw order (X: 0,2,3,7,8; O: 1,4,5,6), played through applyMove.
const anchor = play(newGame("x", "o"), [0, 1, 2, 4, 3, 5, 7, 6, 8]).game;
console.log(
  `\nanchor order [0,1,2,4,3,5,7,6,8]: status=${anchor.status} winner=${anchor.winner} board=${
    anchor.board.map((c) => c ?? "-").join("")
  }`,
);

// Fidelity check: the copy's games must equal the test's reachableArb at a known seed. The test's `states`
// are `reachableArb` mapped to `.game`; probeArb differs only by also carrying `order`, so comparing the
// `.game` of probeArb with a plain `play` over the same order is enough to confirm nothing diverged.
const plainArb = fc.tuple(playersArb, orderArb).map(([[x, o], order]) => play(newGame(x, o), order));
const plain = fc.sample(plainArb, { numRuns: NUM_RUNS, seed: tallySeed }).map((s) => s.game);
const probed = tallySamples.map((s) => s.game);
console.log(
  `\nfidelity: probeArb games equal plain reachableArb games at PROP_SEED=${tallySeed}: ${
    JSON.stringify(plain) === JSON.stringify(probed)
  }`,
);
