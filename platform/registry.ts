import { resolve } from "node:path";
import { schema } from "../app/schema.ts";
import { functions } from "../app/functions.ts";
import { withStorage } from "../sdk/schema.ts";
import type { SQL } from "./compiler.ts";

// A deployment registry, not a path supplied by an HTTP caller.
// These two independent apps happen to run exactly the same application code.
export function loadApps() {
  const data = resolve(Deno.env.get("DATA_DIR") ?? "./data");
  return new Map([
    ["tic-tac-toe", {
      id: "tic-tac-toe",
      file: resolve(data, "tic-tac-toe.sqlite"),
      schema,
      functions,
      token: Deno.env.get("COLUMN_APP_TOKEN") ?? "dev-only",
    }],
    ["tic-tac-toe-json", {
      id: "tic-tac-toe-json",
      file: resolve(data, "tic-tac-toe-json.sqlite"),
      schema: withStorage(schema, "json"),
      functions,
      token: Deno.env.get("JSON_APP_TOKEN") ?? "dev-only",
    }],
  ]);
}
export function trace(engine: "sqlite" | "duckdb", sql: SQL) {
  // stderr: stdout in the reader is reserved for the RPC protocol.
  if (Deno.env.get("TRACE_SQL") === "1") console.error(JSON.stringify({ engine, ...sql }));
}
