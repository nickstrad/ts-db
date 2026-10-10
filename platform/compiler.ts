/** PLATFORM INTERNALS: all application SQL is generated here. */
import { identifier, parseObject, validate, type Node, type Schema, type Table } from "../sdk/schema.ts";
import type { SelectPlan } from "../sdk/db.ts";
export type Dialect = "sqlite" | "duckdb";
export type Bind = string | number | null;
export type SQL = { text: string; values: Bind[] };
export type Row = Record<string, unknown>;
export const quote = (name: string) => `"${identifier(name)}"`;
export const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const system: Record<string, Node> = {
  _id: { kind: "string" }, _creationTime: { kind: "integer" }, _version: { kind: "integer" },
};
export function tableFor(schema: Schema, name: string): Table {
  if (!Object.hasOwn(schema, name)) throw new Error(`Unknown collection: ${name}`);
  return schema[name];
}
function fieldNode(table: Table, name: string): Node {
  if (Object.hasOwn(system, name)) return system[name];
  if (!Object.hasOwn(table.fields, name)) throw new Error(`Unknown field: ${name}`);
  return table.fields[name].node;
}
function scalar(table: Table, name: string): Node {
  const node = fieldNode(table, name);
  if (node.kind === "array") throw new Error(`Array predicates/ordering are not supported: ${name}`);
  return node;
}
function expression(table: Table, name: string, dialect: Dialect): string {
  const node = scalar(table, name);
  if (table.storage === "columns" || Object.hasOwn(system, name)) return quote(name);
  const path = literal(`$.${identifier(name)}`);
  if (dialect === "sqlite") return `json_extract("doc", ${path})`;
  const extract = `json_extract_string("doc", ${path})`;
  if (node.kind === "integer") return `CAST(${extract} AS BIGINT)`;
  if (node.kind === "number") return `CAST(${extract} AS DOUBLE)`;
  if (node.kind === "boolean") return `CAST(CAST(${extract} AS BOOLEAN) AS INTEGER)`;
  return extract;
}
function encode(node: Node, value: unknown): Bind {
  if (value === null) return null;
  if (node.kind === "array") return JSON.stringify(value);
  if (node.kind === "boolean") return value ? 1 : 0;
  return value as string | number;
}
function columnType(node: Node): string {
  if (node.kind === "integer" || node.kind === "boolean") return "INTEGER";
  if (node.kind === "number") return "REAL";
  return "TEXT";
}

/** Schema descriptors -> SQLite DDL; indexes work in either physical layout. */
export function compileDDL(schema: Schema): string[] {
  const statements: string[] = [];
  for (const [name, table] of Object.entries(schema)) {
    const columns = [
      '"_id" TEXT PRIMARY KEY NOT NULL',
      '"_creationTime" INTEGER NOT NULL',
      '"_version" INTEGER NOT NULL CHECK ("_version" >= 1)',
    ];
    if (table.storage === "json") columns.push('"doc" TEXT NOT NULL CHECK (json_valid("doc"))');
    else for (const [field, { node }] of Object.entries(table.fields)) {
      let col = `${quote(field)} ${columnType(node)}${node.nullable ? "" : " NOT NULL"}`;
      if (node.kind === "enum") col += ` CHECK (${quote(field)} IN (${node.values!.map(literal).join(", ")}))`;
      if (node.kind === "boolean") col += ` CHECK (${quote(field)} IN (0, 1))`;
      if (node.kind === "array") col += ` CHECK (${quote(field)} IS NULL OR json_valid(${quote(field)}))`;
      columns.push(col);
    }
    statements.push(`CREATE TABLE IF NOT EXISTS ${quote(name)} (${columns.join(", ")}) STRICT`);
    for (const index of table.indexes) {
      statements.push(`CREATE INDEX IF NOT EXISTS ${quote(`idx_${name}_${index.name}`)} ON ${quote(name)} (${index.fields.map((f) => expression(table, f, "sqlite")).join(", ")})`);
    }
  }
  return statements;
}

/** Logical read plan -> parameterized SQL in the selected engine's dialect. */
export function compileSelect(schema: Schema, plan: SelectPlan, dialect: Dialect): SQL {
  const table = tableFor(schema, plan.table);
  if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 1000) throw new Error("Invalid limit");
  const values: Bind[] = [];
  const bind = (value: Bind) => { values.push(value); return dialect === "sqlite" ? "?" : `$p${values.length}`; };
  const where = plan.filters.map((filter) => {
    const node = scalar(table, filter.field);
    validate(node, filter.value, filter.field);
    const expr = expression(table, filter.field, dialect);
    if (filter.op === "eq" && filter.value === null) return `${expr} IS NULL`;
    if (filter.op !== "eq" && filter.op !== "gt") throw new Error("Unsupported operator");
    if (filter.op === "gt" && (filter.value === null || !["integer", "number"].includes(node.kind))) {
      throw new Error("gt requires a non-null numeric field and value");
    }
    return `${expr} ${filter.op === "eq" ? "=" : ">"} ${bind(encode(node, filter.value))}`;
  });
  const target = dialect === "duckdb" ? `"app".${quote(plan.table)}` : quote(plan.table);
  let projection = "*";
  if (plan.aggregate?.kind === "count") projection = 'COUNT(*) AS "count"';
  if (plan.aggregate?.kind === "countBy") {
    projection = `${expression(table, plan.aggregate.field, dialect)} AS "value", COUNT(*) AS "count"`;
  }
  let text = `SELECT ${projection} FROM ${target}`;
  if (where.length) text += ` WHERE ${where.join(" AND ")}`;
  if (plan.aggregate?.kind === "countBy") text += ' GROUP BY 1 ORDER BY "value" ASC NULLS FIRST';
  else if (!plan.aggregate) {
    if (plan.order) {
      if (!["asc", "desc"].includes(plan.order.direction)) throw new Error("Invalid ordering");
      const { field, direction } = plan.order;
      text += ` ORDER BY ${expression(table, field, dialect)} ${direction.toUpperCase()} NULLS ${direction === "asc" ? "FIRST" : "LAST"}, "_id" ASC`;
    } else text += ' ORDER BY "_id" ASC';
  }
  // count counts all matching documents; countBy limits returned groups, not input rows.
  if (plan.aggregate?.kind !== "count") text += ` LIMIT ${bind(plan.limit)}`;
  return { text, values };
}

export function compileInsert(schema: Schema, name: string, input: unknown, meta: Row): SQL {
  const table = tableFor(schema, name);
  const body = parseObject(table.fields, input);
  const columns = ["_id", "_creationTime", "_version"];
  const values: Bind[] = [meta._id as string, meta._creationTime as number, 1];
  if (table.storage === "json") { columns.push("doc"); values.push(JSON.stringify(body)); }
  else for (const [key, field] of Object.entries(table.fields)) {
    columns.push(key); values.push(encode(field.node, body[key]));
  }
  return {
    text: `INSERT INTO ${quote(name)} (${columns.map(quote).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`, values,
  };
}

/** A document patch is implemented as a validated read/merge/replace within one transaction. */
export function compileReplace(schema: Schema, name: string, id: string, input: unknown): SQL {
  const table = tableFor(schema, name);
  const body = parseObject(table.fields, input);
  const sets: string[] = [];
  const values: Bind[] = [];
  if (table.storage === "json") { sets.push('"doc" = ?'); values.push(JSON.stringify(body)); }
  else for (const [key, field] of Object.entries(table.fields)) {
    sets.push(`${quote(key)} = ?`); values.push(encode(field.node, body[key]));
  }
  sets.push('"_version" = "_version" + 1');
  values.push(id);
  return { text: `UPDATE ${quote(name)} SET ${sets.join(", ")} WHERE "_id" = ?`, values };
}
export function compileDelete(schema: Schema, name: string, id: string): SQL {
  tableFor(schema, name);
  return { text: `DELETE FROM ${quote(name)} WHERE "_id" = ?`, values: [id] };
}
function safeNumber(x: unknown): number {
  const n = Number(x);
  if (!Number.isSafeInteger(n)) throw new Error("Integer result exceeds JavaScript safe range");
  return n;
}
function decodeValue(node: Node, value: unknown): unknown {
  if (value === null) return null;
  if (node.kind === "integer") return safeNumber(value);
  if (node.kind === "number") return Number(value);
  if (node.kind === "boolean") return value === true || value === 1 || value === 1n;
  if (node.kind === "array") return JSON.parse(value as string);
  return value;
}
export function decode(schema: Schema, plan: SelectPlan, rows: Row[]): unknown {
  const table = tableFor(schema, plan.table);
  if (plan.aggregate?.kind === "count") return safeNumber(rows[0].count);
  if (plan.aggregate?.kind === "countBy") {
    const node = fieldNode(table, plan.aggregate.field);
    return rows.map((row) => ({ value: decodeValue(node, row.value), count: safeNumber(row.count) }));
  }
  return rows.map((row) => {
    const body: Row = table.storage === "json" ? JSON.parse(row.doc as string) :
      Object.fromEntries(Object.entries(table.fields).map(([name, f]) => [name, decodeValue(f.node, row[name])]));
    return {
      ...parseObject(table.fields, body),
      _id: row._id, _creationTime: safeNumber(row._creationTime), _version: safeNumber(row._version),
    };
  });
}
