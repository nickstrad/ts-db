// Read-path load: constant 50 requests/s for 2 minutes over a pre-seeded dataset, mixing getGame,
// listGames, moveHistory and winsByMark 4:2:2:1. Every query goes through the single serial reader
// process, which is the capacity limit the README documents; this scenario is how that shows up.
import { buildSummary, readOp, seedGames } from "./lib/scenarios.js";

export const options = {
  scenarios: {
    query_load: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate>0.99"],
    // Arrival-rate executors drop iterations they cannot start; without this a saturated reader
    // would "pass" while serving less than the nominal 50 rps.
    dropped_iterations: ["count==0"],
  },
};

const SEED_GAMES = 30;

export function setup() {
  return { seeded: seedGames(SEED_GAMES) };
}

export default function (data) {
  readOp(data.seeded);
}

export function handleSummary(data) {
  return buildSummary("query_load", data);
}
