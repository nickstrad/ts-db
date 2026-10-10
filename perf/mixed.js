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
  vus: 10,
  duration: "3m",
  thresholds: {
    "http_req_failed": ["< 0.01"],
    "http_req_duration": ["p(95) < 1000"],
  },
};

// Setup phase: seed games
export function setup() {
  console.log("Seeding games...");
  return seedGames(30);
}

export default function (data) {
  const gameIds = data || seededGames;
  // 80% reads, 20% writes
  const isWrite = Math.random() < 0.2;

  if (isWrite) {
    group("write_operation", () => {
      try {
        const response = api("mutation", "createGame", {
          xPlayer: `x_${__VU}_${__ITER}`,
          oPlayer: `o_${__VU}_${__ITER}`,
        });
        check(response, {
          "game created": (r) => r && r.gameId !== undefined,
        });
        if (response && response.gameId) {
          gameIds.push(response.gameId);
        }
      } catch (e) {
        const errorMsg = e.message || "";
        if (errorMsg.includes("409") || errorMsg.includes("conflict")) {
          check(true, { "write conflict (expected)": true });
        } else {
          check(false, { "write failed": false });
        }
      }
    });
  } else {
    group("read_operation", () => {
      if (!gameIds || gameIds.length === 0) {
        check(false, { "games available": false });
        return;
      }

      try {
        const randomGame = gameIds[Math.floor(Math.random() * gameIds.length)];
        const scenario = Math.floor(Math.random() * 4);

        let response;
        switch (scenario) {
          case 0:
            response = api("query", "getGame", { gameId: randomGame });
            check(response, { "getGame succeeded": (r) => r && r._id !== undefined });
            break;
          case 1:
            response = api("query", "listGames", { status: "playing" });
            check(response, { "listGames succeeded": (r) => Array.isArray(r) });
            break;
          case 2:
            response = api("query", "moveHistory", { gameId: randomGame });
            check(response, { "moveHistory succeeded": (r) => Array.isArray(r) });
            break;
          case 3:
            response = api("query", "winsByMark", {});
            check(response, { "winsByMark succeeded": (r) => typeof r === "object" });
            break;
        }
      } catch (e) {
        check(false, { "read failed": false });
      }
    });
  }
}

export const handleSummary = createHandleSummary();
