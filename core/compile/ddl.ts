/**
 * Schema descriptors -> SQLite DDL (plan item 09).
 *
 * PURE: nothing in here raises; a bad identifier comes back as a `SchemaError` and an unindexable
 * field as a `CompileError`.
 *
 * Every table is `STRICT`, so SQLite enforces the column types rather than coercing them, and the
 * declared constraints that STRICT cannot express are emitted as CHECKs: enums as an `IN` list,
 * booleans as `IN (0, 1)` (the encoding `core/compile/select.ts`'s `encode` produces), arrays and
 * the `json` layout's `doc` column as `json_valid`. The DDL is dialect-free: DuckDB only ever reads
 * this database through `ATTACH`, so the writer's DDL is the only DDL.
 */
import { Either } from "effect";
import type { CompileError, SchemaError } from "../errors.ts";
import type { Schema } from "../schema.ts";
import { literal, quote } from "./dialect.ts";
import { columnType, expression } from "./select.ts";

export function compileDDL(schema: Schema): Either.Either<string[], CompileError | SchemaError> {
  return Either.gen(function* () {
    const statements: string[] = [];
    for (const [name, table] of Object.entries(schema)) {
      const columns = [
        '"_id" TEXT PRIMARY KEY NOT NULL',
        '"_creationTime" INTEGER NOT NULL',
        '"_version" INTEGER NOT NULL CHECK ("_version" >= 1)',
      ];
      if (table.storage === "json") {
        columns.push('"doc" TEXT NOT NULL CHECK (json_valid("doc"))');
      } else {
        for (const [field, { node }] of Object.entries(table.fields)) {
          const column = yield* quote(field);
          let col = `${column} ${columnType(node)}${node.nullable ? "" : " NOT NULL"}`;
          // An `enum` node without values cannot come from the `v.enum` builder, and `IN ()` is not
          // legal SQL, so the CHECK is simply omitted rather than emitted empty. The pre-port code
          // raised a `TypeError` on the non-null assertion here instead.
          const allowed = node.values ?? [];
          if (node.kind === "enum" && allowed.length) {
            col += ` CHECK (${column} IN (${allowed.map(literal).join(", ")}))`;
          }
          if (node.kind === "boolean") col += ` CHECK (${column} IN (0, 1))`;
          if (node.kind === "array") col += ` CHECK (${column} IS NULL OR json_valid(${column}))`;
          columns.push(col);
        }
      }
      const target = yield* quote(name);
      statements.push(`CREATE TABLE IF NOT EXISTS ${target} (${columns.join(", ")}) STRICT`);
      // Indexes work in either layout: on a `json` table the indexed expression is the same
      // `json_extract` the WHERE clause will use, which is what makes it usable by the planner.
      for (const index of table.indexes) {
        const indexName = yield* quote(`idx_${name}_${index.name}`);
        const keys: string[] = [];
        for (const field of index.fields) keys.push(yield* expression(table, field, "sqlite"));
        statements.push(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${target} (${keys.join(", ")})`);
      }
    }
    return statements;
  });
}
