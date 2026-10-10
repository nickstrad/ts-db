// Regression-comparison scenario: constant 50 requests/s for 3 minutes, 80% reads (the 4:2:2:1 mix
// from query_load.js) and 20% writes. A write advances the VU's own game by one move, creating a
// fresh game when the previous one finished, so writes never conflict with each other.
import { buildSummary, createGame, GAME_SCRIPTS, playNext, readOp, seedGames } from "./lib/scenarios.js";

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate>0.99"],
    dropped_iterations: ["count==0"],
  },
};

const SEED_GAMES = 30;
const WRITE_SHARE = 0.2;
const { cells } = GAME_SCRIPTS.xWins;

// Module scope is per VU in k6: each VU plays its own game across iterations.
let mine;

export function setup() {
  return { seeded: seedGames(SEED_GAMES) };
}

function write() {
  if (!mine || mine.played >= cells.length) {
    const { game } = createGame(`${__VU}-${__ITER}`);
    mine = game;
    return;
  }
  playNext(mine, cells);
}

export default function (data) {
  if (Math.random() < WRITE_SHARE) write();
  else readOp(data.seeded);
}

export function handleSummary(data) {
  return buildSummary("mixed", data);
}
