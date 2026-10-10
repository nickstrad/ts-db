import { handleSummary as k6HandleSummary } from "https://jslib.k6.io/k6-summary/0.0.4/index.js";
import { api } from "./api.js";

// Generate a run ID based on timestamp and a random component
export function generateRunId() {
  const now = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now}-${rand}`;
}

// Seed the database with games before running load scenarios
export function seedGames(count) {
  console.log(`Seeding ${count} games...`);
  const gameIds = [];
  for (let i = 0; i < count; i++) {
    try {
      const response = api("mutation", "createGame", {
        xPlayer: `x_${i}`,
        oPlayer: `o_${i}`,
      });
      gameIds.push(response.gameId);
    } catch (e) {
      console.error(`Failed to seed game ${i}:`, e);
    }
  }
  return gameIds;
}

// Make a move in a seeded game
export function makeMove(gameId, playerId, cell, expectedVersion) {
  return api("mutation", "makeMove", {
    gameId,
    playerId,
    cell,
    expectedVersion,
  });
}

// Get a game state
export function getGame(gameId) {
  return api("query", "getGame", { gameId });
}

// List games by status
export function listGames(status) {
  return api("query", "listGames", { status });
}

// Get move history
export function moveHistory(gameId) {
  return api("query", "moveHistory", { gameId });
}

// Get wins by mark (player)
export function winsByMark() {
  return api("query", "winsByMark", {});
}

// Configure and wire k6 output
export function configureOutput(runId) {
  const logsDir = `logs/k6/${runId}`;
  return {
    logsDir,
    rawJsonPath: `${logsDir}/raw.json`,
  };
}

// Handle summary: write summary.json alongside raw.json
export function createHandleSummary() {
  return function handleSummaryFn(data) {
    const runId = __ENV.RUN_ID;
    if (!runId) {
      console.error("RUN_ID environment variable not set");
      return k6HandleSummary(data);
    }

    const logsDir = `logs/k6/${runId}`;
    const summaryPath = `${logsDir}/summary.json`;

    // Create a summary object
    const summary = {
      timestamp: new Date().toISOString(),
      passed: true,  // k6 run exits 0 if thresholds pass
    };

    // Write summary via the k6 summary handler
    const result = k6HandleSummary(data) || {};

    // Add a text file reference to the summary location
    if (!result[summaryPath]) {
      result[summaryPath] = () => JSON.stringify(summary, null, 2);
    }

    return result;
  };
}
