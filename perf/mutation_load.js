// Write-path load: 1 -> 20 VUs over 1 minute, held for 1 minute. Every iteration creates its own
// game and plays it out with expectedVersion; a deliberate stale-version move is mixed in and must
// be rejected as a conflict (counted in `conflicts`, never in http_req_failed).
import exec from "k6/execution";
import { check } from "k6";
import { buildSummary, createGame, GAME_SCRIPTS, playNext, staleMove } from "./lib/scenarios.js";

export const options = {
  scenarios: {
    mutation_load: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "1m", target: 20 },
        { duration: "1m", target: 20 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    "http_req_duration{expected_response:true}": ["p(95)<400"],
    // Conflicts are expected statuses for the stale write, so they must not show up here.
    http_req_failed: ["rate<0.01"],
  },
};

const { cells } = GAME_SCRIPTS.xWins;
// A stale-version attempt precedes every STALE_EVERY-th move of the iteration's game.
const STALE_EVERY = 3;

export default function () {
  const label = `${__VU}-${__ITER}`;
  const { r, game } = createGame(label);
  if (!game) {
    // Fail fast: a down server must abort the run, not spin hot until the stages run out.
    exec.test.abort(`createGame failed: status=${r.res.status} body=${r.res.body}`);
  }
  for (let i = 0; i < cells.length; i++) {
    if ((__ITER + i) % STALE_EVERY === 0) staleMove(game, cells);
    const moved = playNext(game, cells);
    check(moved, { "makeMove: game advanced": () => game.played === i + 1 });
  }
}

export function handleSummary(data) {
  return buildSummary("mutation_load", data);
}
