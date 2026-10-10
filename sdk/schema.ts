/**
 * App-facing schema surface.
 *
 * The descriptors and the validation logic now live in `core/schema.ts`, where they are total:
 * every rejection comes back as a `SchemaError` in an `Either`. This module is the compatibility
 * seam for the pre-port, throwing API (plan item 04, work 3): it re-exports the core types and
 * builders, and adds `*OrThrow` wrappers that render a `SchemaError` back into the exact `Error`
 * message the old code produced. `platform/compiler.ts`, `platform/sqlite.ts` and
 * `sdk/functions.ts` therefore compile untouched, via the legacy aliases at the bottom.
 *
 * `AppTable.index` and `defineTable`/`defineSchema` keep throwing for the same reason: they run at
 * module load in `app/schema.ts`, which has nowhere to put an `Either`. Later items in the Effect
 * port move those callers onto the core API and delete the wrappers.
 */
import { Either, Function as EffectFunction } from "effect";
import type { SchemaError } from "../core/errors.ts";
import * as Core from "../core/schema.ts";
import { type Fields, type Infer, type Node, type Schema, type Storage, Table } from "../core/schema.ts";

export { Table, v, withStorage } from "../core/schema.ts";
export type { Body, Document, Field, Fields, Index, Infer, Node, Schema, Storage } from "../core/schema.ts";

/**
 * Renders a structured `SchemaError` into the pre-port message, verbatim — `tests/core_test.ts`
 * asserts `/Unknown field/` and `/expected integer/` against these strings. The switch is total
 * over `SchemaFailure`: adding a reason without a case here is a compile error.
 */
export function formatSchemaError(error: SchemaError): Error {
  const message = ((): string => {
    switch (error.reason) {
      case "type-mismatch":
        return `${error.path}: expected ${error.expected ?? "a valid value"}`;
      case "not-an-object":
        return "Expected an object";
      case "unknown-field":
        return `Unknown field: ${error.path}`;
      case "invalid-identifier":
        return `Invalid identifier: ${error.path}`;
      case "reserved-field":
        return `Reserved field: ${error.path}`;
      case "reserved-table":
        return `Reserved table: ${error.path}`;
      case "empty-index":
        return "An index needs at least one field";
      case "unindexable-field":
        return `Cannot index ${error.path}`;
      case "duplicate-index":
        return `Duplicate index ${error.path}`;
      default:
        return EffectFunction.absurd<string>(error.reason);
    }
  })();
  return new Error(message, { cause: error });
}

const orThrow = <A>(either: Either.Either<A, SchemaError>): A =>
  Either.getOrThrowWith(either, formatSchemaError);

/** `core/schema.ts`'s `identifier`, throwing `Invalid identifier: <name>` instead of returning a left. */
export function identifierOrThrow(name: string): string {
  return orThrow(Core.identifier(name));
}

/** `core/schema.ts`'s `validate`, throwing `<path>: expected <kind>[ or null]` instead of returning a left. */
export function validateOrThrow(node: Node, value: unknown, path: string): unknown {
  return orThrow(Core.validate(node, value, path));
}

/** `core/schema.ts`'s `parseObject`, throwing `Unknown field: <key>` and friends instead of returning a left. */
export function parseObjectOrThrow<F extends Fields>(fields: F, input: unknown, partial = false): Infer<F> {
  return orThrow(Core.parseObject(fields, input, partial));
}

/**
 * A `Table` whose `index` throws, for schemas declared at module load. Identical data to
 * `core/schema.ts`'s `Table`, so platform code that only reads `fields`/`storage`/`indexes` is
 * unaffected by which of the two it is handed.
 */
export class AppTable<F extends Fields = Fields> extends Table<F> {
  index(name: string, fields: readonly (keyof F & string)[]): AppTable<F> {
    const next = orThrow(this.addIndex(name, fields));
    return new AppTable(next.fields, next.storage, next.indexes);
  }

  override storeAs(storage: Storage): AppTable<F> {
    return new AppTable(this.fields, storage, this.indexes);
  }
}

/** Declares a table, throwing on a bad or reserved field name. */
export function defineTable<F extends Fields>(fields: F): AppTable<F> {
  orThrow(Core.defineTable(fields));
  return new AppTable(fields);
}

/** Validates a schema's table names, throwing on a bad or reserved one, and returns it unchanged. */
export function defineSchema<S extends Schema>(schema: S): S {
  return orThrow(Core.defineSchema(schema));
}

// Legacy aliases: the names `platform/` and `sdk/functions.ts` still import. Both the throwing
// behaviour and the messages are unchanged from before the port.
export { identifierOrThrow as identifier, parseObjectOrThrow as parseObject, validateOrThrow as validate };
