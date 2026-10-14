import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { EVENTLOG_DDL } from "../../../core/eventlog/ddl.ts";
const root = await Deno.makeTempDir({ prefix: "ffi06-old-v2-" });
const file = root + "/events.duckdb";
assert.ok(Deno.args[0], "supply a closed v2 event-log file to copy");
await Deno.copyFile(Deno.args[0], file);
const instance = await DuckDBInstance.create(file);
const connection = await instance.connect();
try {
  await connection.run("ALTER TABLE sql_events DROP COLUMN path");
  for (const ddl of EVENTLOG_DDL) await connection.run(ddl);
  for (const ddl of EVENTLOG_DDL) await connection.run(ddl);
  const column = (await connection.runAndReadAll(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'sql_events' AND column_name = 'path'",
  )).getRowObjectsJson();
  assert.deepEqual(column, [{ column_name: "path", data_type: "VARCHAR", is_nullable: "YES" }]);
  const rows = (await connection.runAndReadAll(
    "SELECT count(*) AS rows, count(path) AS populated FROM sql_events",
  )).getRowObjectsJson();
  assert.equal(rows[0].populated, "0");
  assert.ok(Number(rows[0].rows) > 0);
  console.log(JSON.stringify({ migration: "PASS", ddl_runs: 2, column, existing_rows: rows }));
} finally {
  connection.closeSync();
  instance.closeSync();
  await Deno.remove(root, { recursive: true });
}
