// TEMPORARY SCAFFOLD for property-test experiment (item 12) — to be replaced by the real item 04 implementation. Do not build on this.

import { SchemaError } from "./errors.ts";

export type Either<L, R> = { tag: "Left"; value: L } | { tag: "Right"; value: R };
export const Left = <L, R>(value: L): Either<L, R> => ({ tag: "Left", value });
export const Right = <L, R>(value: R): Either<L, R> => ({ tag: "Right", value });

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

export function validate(node: Node, value: unknown, path: string = ""): Either<SchemaError, unknown> {
  if (value === null && node.nullable) return Right(null);

  let valid = false;
  switch (node.kind) {
    case "string":
      valid = typeof value === "string";
      break;
    case "number":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "integer":
      valid = typeof value === "number" && Number.isSafeInteger(value);
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "enum":
      valid = typeof value === "string" && !!node.values?.includes(value);
      break;
    case "array": {
      if (Array.isArray(value) && (node.length === undefined || value.length === node.length)) {
        const results: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          const elem = validate(node.item!, value[i], `${path}[${i}]`);
          if (elem.tag === "Left") return elem;
          results.push(elem.value);
        }
        return Right(results);
      }
      break;
    }
  }

  if (!valid) {
    const expected = node.kind + (node.nullable ? " | null" : "");
    return Left(new SchemaError(path, expected, value));
  }

  return Right(value);
}

export function parseObject<F extends Fields>(
  fields: F,
  input: unknown,
  partial = false,
): Either<SchemaError, Infer<F>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Left(new SchemaError("", "object", input));
  }

  const obj = input as Record<string, unknown>;

  // Check for unknown fields
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(fields, key)) {
      return Left(new SchemaError(key, "known field", key));
    }
  }

  const result: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(fields)) {
    if (partial && !Object.hasOwn(obj, key)) continue;

    const fieldResult = validate(field.node, obj[key], key);
    if (fieldResult.tag === "Left") return fieldResult;
    result[key] = fieldResult.value;
  }

  return Right(result as Infer<F>);
}

export function identifier(name: string): Either<SchemaError, string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return Left(new SchemaError("", "valid identifier", name));
  }
  return Right(name);
}
