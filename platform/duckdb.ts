// Reader process ONLY. It deliberately never imports node:sqlite.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { Documents } from "../sdk/db.ts";
import type { Schema } from "../sdk/schema.ts";
import type { AnyDefinition } from "../sdk/functions.ts";
import { compileSelect, decode, literal, type SQL } from "./compiler.ts";
// Keep this type local: do NOT import the SQLite module merely for its logger.
type Trace = (engine: "sqlite" | "duckdb", sql: SQL) => void;

export class DuckReader<S extends Schema> {
  private constructor(
    private instance: DuckDBInstance,
    private connection: DuckDBConnection,
    private schema: S,
    private trace: Trace,
  ) {}
  static async open<S extends Schema>(file: string, schema: S, trace: Trace = () => {}): Promise<DuckReader<S>> {
    const instance = await DuckDBInstance.create(":memory:", { threads: "2", memory_limit: "256MB" });
    const connection = await instance.connect();
    try {
      await connection.run("INSTALL sqlite");
      await connection.run("LOAD sqlite");
      await connection.run(`ATTACH ${literal(file)} AS "app" (TYPE SQLITE, READ_ONLY)`);
      return new DuckReader(instance, connection, schema, trace);
    } catch (e) { connection.closeSync(); instance.closeSync(); throw e; }
  }
  // The worker serializes whole query handlers: never share an active transaction.
  async query(definition: AnyDefinition, args: unknown): Promise<unknown> {
    if (definition.kind !== "query") throw new Error("Expected a query");
    await this.connection.run("BEGIN TRANSACTION");
    let active = true;
    const db = new Documents<S>(async (operation) => {
      if (!active) throw new Error("Query context has expired");
      if (operation.kind !== "select") throw new Error("Queries cannot write");
      const sql = compileSelect(this.schema, operation, "duckdb");
      this.trace("duckdb", sql);
      const parameters = Object.fromEntries(sql.values.map((value, i) => [`p${i + 1}`, value]));
      const reader = await this.connection.runAndReadAll(sql.text, parameters);
      return decode(this.schema, operation, reader.getRowObjects());
    });
    try {
      const result = await definition.invoke(db, args);
      const safeResult = JSON.parse(JSON.stringify(result ?? null));
      await this.connection.run("COMMIT");
      return safeResult;
    } catch (e) {
      await this.connection.run("ROLLBACK");
      throw e;
    } finally { active = false; }
  }
  close(): void { this.connection.closeSync(); this.instance.closeSync(); }
}
