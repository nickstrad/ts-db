import http from "k6/http";
import { check, group } from "k6";
import { generateRunId, seedGames, createHandleSummary } from "./lib/scenarios.js";
import { api } from "./lib/api.js";

// Generate run ID once per execution
const runId = __ENV.RUN_ID || generateRunId();
__ENV.RUN_ID = runId;

// Seeded games will be populated in setup()
let seededGames = [];

export const options = {
  stages: [
    {
      duration: "2m",
      target: 50,  // 50 rps for 2 minutes
    },
  ],
  thresholds: {
    "http_req_failed": ["< 0.01"],
    "http_req_duration": ["p(95) < 500"],
  },
};

// Setup phase: seed games
export function setup() {
  console.log("Seeding games...");
  return seedGames(50);
}

// Define weighted scenarios
const scenarios = [
  { name: "getGame", weight: 4 },
  { name: "listGames", weight: 2 },
  { name: "moveHistory", weight: 2 },
  { name: "winsByMark", weight: 1 },
];

// Normalize weights to probabilities
const totalWeight = scenarios.reduce((sum, s) => sum + s.weight, 0);
for (const scenario of scenarios) {
  scenario.probability = scenario.weight / totalWeight;
}

// Cumulative probabilities for selection
let cumulative = 0;
for (const scenario of scenarios) {
  scenario.cumulativeProbability = cumulative;
  cumulative += scenario.probability;
}

// Select scenario based on weighted probability
function selectScenario() {
  const rand = Math.random();
  for (const scenario of scenarios) {
    if (rand < scenario.cumulativeProbability + scenario.probability) {
      return scenario.name;
    }
  }
  return scenarios[scenarios.length - 1].name;
}

export default function (data) {
  const gameIds = data || seededGames;
  if (!gameIds || gameIds.length === 0) {
    check(false, { "games seeded": false });
    return;
  }

  const scenario = selectScenario();
  const randomGame = gameIds[Math.floor(Math.random() * gameIds.length)];

  group(scenario, () => {
    try {
      let response;
      switch (scenario) {
        case "getGame":
          response = api("query", "getGame", { gameId: randomGame });
          check(response, {
            "getGame succeeded": (r) => r && r._id !== undefined,
          });
          break;
        case "listGames":
          response = api("query", "listGames", { status: "playing" });
          check(response, {
            "listGames succeeded": (r) => Array.isArray(r),
          });
          break;
        case "moveHistory":
          response = api("query", "moveHistory", { gameId: randomGame });
          check(response, {
            "moveHistory succeeded": (r) => Array.isArray(r),
          });
          break;
        case "winsByMark":
          response = api("query", "winsByMark", {});
          check(response, {
            "winsByMark succeeded": (r) => typeof r === "object",
          });
          break;
      }
    } catch (e) {
      check(false, {
        [`${scenario} failed`]: false,
      });
    }
  });
}

export const handleSummary = createHandleSummary();
