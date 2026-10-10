/** App-facing schema descriptors. Types are inferred; descriptors survive at runtime. */
export type Node = {
  kind: "string" | "number" | "integer" | "boolean" | "enum" | "array";
  nullable?: boolean;
  values?: readonly string[];
  item?: Node;
  length?: number;
};
export type Field<T = unknown> = { node: Node; readonly _type?: T };
export type Fields = Record<string, Field>;
export type Infer<F extends Fields> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };
export type Storage = "columns" | "json";

export const v = {
  string: (): Field<string> => ({ node: { kind: "string" } }),
  number: (): Field<number> => ({ node: { kind: "number" } }),
  integer: (): Field<number> => ({ node: { kind: "integer" } }),
  boolean: (): Field<boolean> => ({ node: { kind: "boolean" } }),
  enum: <const T extends readonly [string, ...string[]]>(...values: T): Field<T[number]> =>
    ({ node: { kind: "enum", values } }),
  nullable: <T>(field: Field<T>): Field<T | null> =>
    ({ node: { ...field.node, nullable: true } }),
  array: <T>(item: Field<T>, length?: number): Field<T[]> =>
    ({ node: { kind: "array", item: item.node, length } }),
};

export class Table<F extends Fields = Fields> {
  constructor(
    readonly fields: F,
    readonly storage: Storage = "columns",
    readonly indexes: readonly { name: string; fields: readonly string[] }[] = [],
  ) {}
  index(name: string, fields: readonly (keyof F & string)[]): Table<F> {
    identifier(name);
    if (!fields.length) throw new Error("An index needs at least one field");
    for (const field of fields) {
      if (!Object.hasOwn(this.fields, field) || this.fields[field].node.kind === "array") {
        throw new Error(`Cannot index ${field}`);
      }
    }
    if (this.indexes.some((i) => i.name === name)) throw new Error(`Duplicate index ${name}`);
    return new Table(this.fields, this.storage, [...this.indexes, { name, fields }]);
  }
  storeAs(storage: Storage): Table<F> { return new Table(this.fields, storage, this.indexes); }
}
export type Schema = Record<string, Table>;
export type Document<S extends Schema, K extends keyof S> = Infer<S[K]["fields"]> & {
  _id: string;
  _creationTime: number;
  _version: number;
};
export type Body<S extends Schema, K extends keyof S> = Infer<S[K]["fields"]>;

export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return name;
}
export function defineTable<F extends Fields>(fields: F): Table<F> {
  for (const name of Object.keys(fields)) {
    identifier(name);
    if (name.startsWith("_")) throw new Error(`Reserved field: ${name}`);
  }
  return new Table(fields);
}
export function defineSchema<S extends Schema>(schema: S): S {
  for (const name of Object.keys(schema)) {
    identifier(name);
    if (name.startsWith("_") || name.toLowerCase().startsWith("sqlite_")) {
      throw new Error(`Reserved table: ${name}`);
    }
  }
  return schema;
}
export function withStorage<S extends Schema>(schema: S, storage: Storage): S {
  return Object.fromEntries(Object.entries(schema).map(([k, t]) => [k, t.storeAs(storage)])) as S;
}

export function validate(node: Node, value: unknown, path: string): unknown {
  if (value === null && node.nullable) return null;
  let valid = false;
  switch (node.kind) {
    case "string": valid = typeof value === "string"; break;
    case "number": valid = typeof value === "number" && Number.isFinite(value); break;
    case "integer": valid = typeof value === "number" && Number.isSafeInteger(value); break;
    case "boolean": valid = typeof value === "boolean"; break;
    case "enum": valid = typeof value === "string" && !!node.values?.includes(value); break;
    case "array":
      if (Array.isArray(value) && (node.length === undefined || value.length === node.length)) {
        return value.map((x, i) => validate(node.item!, x, `${path}[${i}]`));
      }
  }
  if (!valid) throw new Error(`${path}: expected ${node.kind}${node.nullable ? " or null" : ""}`);
  return value;
}
export function parseObject<F extends Fields>(fields: F, input: unknown, partial = false): Infer<F> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object");
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unknown field: ${key}`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (partial && !Object.hasOwn(obj, key)) continue;
    result[key] = validate(field.node, obj[key], key);
  }
  return result as Infer<F>;
}
