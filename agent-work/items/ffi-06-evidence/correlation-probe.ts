import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { CATALOG } from "../../../platform/analysis/catalog.ts";

const instance = await DuckDBInstance.create(Deno.args[0], { access_mode: "READ_ONLY" });
const connection = await instance.connect();
try {
  const prepared = await connection.prepare(CATALOG["deadline-hits-per-handler-hour"].sql);
  prepared.bind({ since: null, until: null, appId: null });
  const rows = (await prepared.runAndReadAll()).getRowObjectsJson();
  const matching = rows.filter((r) => r.name === "winsByMark" && r.path === "nonblocking");
  assert.equal(matching.reduce((sum, r) => sum + Number(r.deadline_hits), 0), 20);
  assert.equal(rows.filter((r) => r.name === null).length, 0);
  console.log(JSON.stringify({ correlation: "PASS", rows }));
} finally {
  connection.closeSync();
  instance.closeSync();
}
