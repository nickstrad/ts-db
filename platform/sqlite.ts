// Writer process ONLY. Never import this file into the DuckDB process.
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { Documents, type Operation, type SelectPlan } from "../sdk/db.ts";
import { parseObject, type Schema } from "../sdk/schema.ts";
import { type AnyDefinition, runHandlerAsPromise } from "../sdk/functions.ts";
import { compileDDL, compileSelect, compileInsert, compileReplace, compileDelete, decode, tableFor, type Row, type SQL } from "./compiler.ts";
export type Trace = (engine: "sqlite" | "duckdb", sql: SQL) => void;

export class SQLiteWriter<S extends Schema> {
  private database: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(
    file: string, readonly schema: S,
    private trace: Trace = () => {},
    private clock = () => Date.now(),
    private newId: () => string = () => crypto.randomUUID(),
  ) {
    this.database = new DatabaseSync(file);
    try {
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.database.exec("BEGIN IMMEDIATE");
      this.database.exec('CREATE TABLE IF NOT EXISTS "_platform_schema" (id INTEGER PRIMARY KEY CHECK (id = 1), definition TEXT NOT NULL) STRICT');
      const fingerprint = JSON.stringify(schema);
      const existing = this.database.prepare('SELECT definition FROM "_platform_schema" WHERE id = 1').get();
      if (existing && existing.definition !== fingerprint) {
        throw new Error("Schema/storage changed. MVP refuses automatic migration; use a new database or an explicit migration.");
      }
      for (const text of compileDDL(schema)) { this.trace("sqlite", { text, values: [] }); this.database.exec(text); }
      if (!existing) this.database.prepare('INSERT INTO "_platform_schema" VALUES (1, ?)').run(fingerprint);
      this.database.exec("COMMIT");
    } catch (e) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      this.database.close();
      throw e;
    }
  }
  private exclusive<T>(job: () => Promise<T> | T): Promise<T> {
    if (this.pending >= 1000) return Promise.reject(new Error("Writer queue full"));
    this.pending++;
    const next = this.tail.then(job);
    this.tail = next.catch(() => {});
    return next.finally(() => { this.pending--; });
  }
  private select(plan: SelectPlan): unknown {
    const sql = compileSelect(this.schema, plan, "sqlite");
    this.trace("sqlite", sql);
    return decode(this.schema, plan, this.database.prepare(sql.text).all(...sql.values));
  }
  private write(sql: SQL): void {
    this.trace("sqlite", sql);
    this.database.prepare(sql.text).run(...sql.values);
  }
  private get(table: string, id: string): Row | undefined {
    return (this.select({ kind: "select", table, filters: [{ field: "_id", op: "eq", value: id }], limit: 1 }) as Row[])[0];
  }
  private execute(op: Operation): unknown {
    switch (op.kind) {
      case "select": return this.select(op);
      case "insert": {
        const id = this.newId();
        this.write(compileInsert(this.schema, op.table, op.value, { _id: id, _creationTime: this.clock() }));
        return id;
      }
      case "patch": {
        const table = tableFor(this.schema, op.table);
        const patch = parseObject(table.fields, op.value, true);
        const old = this.get(op.table, op.id);
        if (!old) throw new Error("Document not found");
        const body = Object.fromEntries(Object.keys(table.fields).map((key) => [key, old[key]]));
        this.write(compileReplace(this.schema, op.table, op.id, { ...body, ...patch }));
        return null;
      }
      case "delete":
        this.write(compileDelete(this.schema, op.table, op.id));
        return null;
    }
  }
  async mutation(definition: AnyDefinition, args: unknown): Promise<unknown> {
    if (definition.kind !== "mutation") throw new Error("Expected a mutation");
    return await this.exclusive(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      let active = true;
      // TEMPORARY BRIDGE (item 10): removed by item 15, which turns this class into the scoped
      // `Storage` service and builds an Effect `Execute` directly. Until then the promise-returning
      // executor is adapted with `Effect.promise` (a rejection becomes a defect, which
      // `runHandlerAsPromise` rethrows unchanged), and the handler effect — handlers are Effects
      // now, not async functions — is run here rather than awaited.
      const documents = new Documents<S>((op) =>
        Effect.promise(async () => {
          if (!active) throw new Error("Transaction context has expired");
          return this.execute(op);
        })
      );
      try {
        const result = await runHandlerAsPromise(definition, documents, args);
        // Catch non-JSON results before committing; transport cannot serialize them later.
        const safeResult = JSON.parse(JSON.stringify(result ?? null));
        this.database.exec("COMMIT");
        return safeResult;
      } catch (e) {
        this.database.exec("ROLLBACK");
        throw e;
      } finally { active = false; }
    });
  }
  async snapshot(destination: string): Promise<void> {
    await this.exclusive(() => {
      // Consistent standalone backup, including committed data still in the WAL.
      // Never use copyFile(liveDatabase, backup) on a live WAL database.
      this.database.prepare("VACUUM INTO ?").run(destination);
    });
  }
  async close(): Promise<void> { await this.tail; this.database.close(); }
}
