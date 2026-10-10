import http from "k6/http";
import { check, group } from "k6";
import { generateRunId, createHandleSummary } from "./lib/scenarios.js";
import { api } from "./lib/api.js";

// Generate run ID once per execution
const runId = __ENV.RUN_ID || generateRunId();
__ENV.RUN_ID = runId;

export const options = {
  vus: 1,
  stages: [
    { duration: "1m", target: 20 },  // Ramp up from 1 to 20 VUs over 1 minute
    { duration: "1m", target: 20 },  // Hold at 20 VUs for 1 minute
  ],
  thresholds: {
    "checks": ["rate > 0.99"],
    "http_req_duration{expected_response:true}": ["p(95) < 400"],
  },
};

export default function () {
  const vuId = `vu-${__VU}`;
  const currentVersion = {};

  group("create_game", () => {
    try {
      const response = api("mutation", "createGame", {
        xPlayer: `${vuId}-x`,
        oPlayer: `${vuId}-o`,
      });
      currentVersion.gameId = response.gameId;
      currentVersion.version = response._version;
      check(response, {
        "game created": (r) => r && r.gameId !== undefined,
        "has version": (r) => r && r._version !== undefined,
      });
    } catch (e) {
      check(false, {
        "create game failed": false,
      });
    }
  });

  // Make moves with expectedVersion - conflicts are expected
  if (currentVersion.gameId) {
    group("make_moves", () => {
      for (let i = 0; i < 3; i++) {
        try {
          const response = api("mutation", "makeMove", {
            gameId: currentVersion.gameId,
            playerId: `${vuId}-x`,
            cell: i,
            expectedVersion: currentVersion.version,
          });
          currentVersion.version = response._version;
          check(response, {
            "move succeeded": (r) => r && r.gameId !== undefined,
          });
        } catch (e) {
          // Check if this is a conflict error (expected)
          const errorMsg = e.message || "";
          if (errorMsg.includes("409") || errorMsg.includes("stale") || errorMsg.includes("conflict")) {
            // This is an expected conflict - track it as a successful check
            check(true, {
              "conflict detected (expected)": true,
            });
          } else {
            // Unexpected error
            check(false, {
              "move failed unexpectedly": false,
            });
          }
        }
      }
    });
  }
}

export const handleSummary = createHandleSummary();
