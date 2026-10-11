// Scratch load-shape exploration for Luna quest lx-04. Uses the item-14 read/write mix and
// API helpers; this script lives outside perf/ so it cannot become a production perf scenario.
import { buildSummary, createGame, GAME_SCRIPTS, playNext, readOp, seedGames } from "../../perf/lib/scenarios.js";

const SHAPES = {
  ramp: {
    startVUs: 10,
    stages: [
      { duration: "30s", target: 10 },
      { duration: "1m", target: 50 },
      { duration: "1m", target: 100 },
      { duration: "1m", target: 200 },
      { duration: "1m", target: 300 },
      { duration: "1m", target: 300 },
    ],
  },
  spike: {
    startVUs: 10,
    stages: [
      { duration: "1m", target: 10 },
      { duration: "30s", target: 300 },
      { duration: "1m", target: 10 },
    ],
  },
  sustained: {
    startVUs: 100,
    stages: [
      { duration: "5m", target: 100 },
    ],
  },
};

const shape = __ENV.SHAPE ?? "";
if (!(shape in SHAPES)) throw new Error(`SHAPE must be one of ${Object.keys(SHAPES).join(", ")}`);

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    load: { executor: "ramping-vus", gracefulRampDown: "10s", ...SHAPES[shape] },
  },
};

const WRITE_SHARE = 0.2;
const { cells } = GAME_SCRIPTS.xWins;
let mine;

export function setup() {
  return { seeded: seedGames(30) };
}

function write() {
  if (!mine || mine.played >= cells.length) {
    mine = createGame(`${__VU}-${__ITER}`).game;
    return;
  }
  playNext(mine, cells);
}

export default function (data) {
  if (Math.random() < WRITE_SHARE) write();
  else readOp(data.seeded);
}

export function handleSummary(data) {
  return buildSummary(`lx-04-${shape}`, data);
}
