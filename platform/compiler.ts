/**
 * PLATFORM INTERNALS: all application SQL is generated here.
 *
 * The generation itself moved into `core/compile/*` and `core/plan.ts`, where it is **total**:
 * every rejection is a `CompileError`, `DecodeError` or `SchemaError` in an `Either` (plan item 09).
 * This module is the compatibility seam for the pre-port, throwing API — the same role
 * `sdk/schema.ts` plays for `core/schema.ts`: it re-exports the pure functions and adds `*OrThrow`
 * wrappers that render a tagged error back into the exact `Error` message the old code produced.
 * `platform/sqlite.ts`, `platform/duckdb.ts`, `scripts/explain.ts` and `tests/core_test.ts`
 * therefore compile untouched, via the legacy aliases at the bottom of this file.
 *
 * Later items in the Effect port move those callers onto the `core/compile/*` API directly and
 * delete the wrappers.
 */
import { Either, Function as EffectFunction } from "effect";
import type { CompileError, DecodeError, SchemaError } from "../core/errors.ts";
import { formatSchemaError } from "../sdk/schema.ts";
import type { Schema, Table } from "../sdk/schema.ts";
import type { SelectPlan } from "../sdk/db.ts";
import * as Sql from "../core/compile/dialect.ts";
import * as Ddl from "../core/compile/ddl.ts";
import * as Select from "../core/compile/select.ts";
import * as Write from "../core/compile/write.ts";
import * as Decode from "../core/compile/decode.ts";

export type { Bind, Dialect, Row, SQL } from "../core/compile/dialect.ts";
export { literal } from "../core/compile/dialect.ts";

// The pure, total versions, for callers that want the error in a value rather than a stack.
export { compileDDL as compileDDLEither } from "../core/compile/ddl.ts";
export { compileSelect as compileSelectEither, tableFor as tableForEither } from "../core/compile/select.ts";
export {
  compileDelete as compileDeleteEither,
  compileInsert as compileInsertEither,
  compileReplace as compileReplaceEither,
} from "../core/compile/write.ts";
export { decode as decodeEither } from "../core/compile/decode.ts";
export { quote as quoteEither } from "../core/compile/dialect.ts";

type AnyCompileError = CompileError | DecodeError | SchemaError;

/**
 * Renders a structured compile failure into the pre-port message, verbatim —
 * `tests/core_test.ts` asserts `/Array predicates/` and `/Unknown field/` against these strings.
 * The switch is total over `CompileFailure`: adding a reason without a case here is a compile error.
 */
export function formatCompileError(error: CompileError): Error {
  const message = ((): string => {
    switch (error.reason) {
      case "unknown-collection":
        return `Unknown collection: ${error.table}`;
      case "unknown-field":
        return `Unknown field: ${error.field}`;
      case "array-predicate":
        return `Array predicates/ordering are not supported: ${error.field}`;
      case "unsupported-operator":
        return "Unsupported operator";
      case "gt-requires-numeric":
        return "gt requires a non-null numeric field and value";
      case "invalid-limit":
        return "Invalid limit";
      case "invalid-ordering":
        return "Invalid ordering";
      case "empty-enum":
        return `Enum has no values: ${error.field}`;
      default:
        return EffectFunction.absurd<string>(error.reason);
    }
  })();
  return new Error(message, { cause: error });
}

/**
 * Renders a decode failure. `unsafe-integer` keeps the pre-port wording; the other two reasons are
 * new — the old code let `JSON.parse`'s own `SyntaxError` escape, and a column missing from the
 * row now surfaces as `missing-column` instead of failing downstream.
 */
export function formatDecodeError(error: DecodeError): Error {
  const message = ((): string => {
    switch (error.reason) {
      case "unsafe-integer":
        return "Integer result exceeds JavaScript safe range";
      case "malformed-json":
        return `Malformed JSON in stored value${error.field ? `: ${error.field}` : ""}`;
      case "missing-column":
        return `Missing column${error.field ? `: ${error.field}` : ""}`;
      default:
        return EffectFunction.absurd<string>(error.reason);
    }
  })();
  return new Error(message, { cause: error });
}

/** Dispatches on the tag, so one `orThrow` covers all three error channels the compiler has. */
function formatError(error: AnyCompileError): Error {
  switch (error._tag) {
    case "CompileError":
      return formatCompileError(error);
    case "DecodeError":
      return formatDecodeError(error);
    case "SchemaError":
      return formatSchemaError(error);
    default:
      return EffectFunction.absurd<Error>(error);
  }
}

const orThrow = <A>(either: Either.Either<A, AnyCompileError>): A =>
  Either.getOrThrowWith(either, formatError);

/** `core/compile/dialect.ts`'s `quote`, raising `Invalid identifier: <name>` instead of a left. */
export function quoteOrThrow(name: string): string {
  return orThrow(Sql.quote(name));
}

/** `core/compile/select.ts`'s `tableFor`, raising `Unknown collection: <name>` instead of a left. */
export function tableForOrThrow(schema: Schema, name: string): Table {
  return orThrow(Select.tableFor(schema, name));
}

/** Schema descriptors -> SQLite DDL; indexes work in either physical layout. */
export function compileDDLOrThrow(schema: Schema): string[] {
  return orThrow(Ddl.compileDDL(schema));
}

/** Logical read plan -> parameterized SQL in the selected engine's dialect. */
export function compileSelectOrThrow(
  schema: Schema,
  plan: SelectPlan,
  dialect: Sql.Dialect,
): Sql.SQL {
  return orThrow(Select.compileSelect(schema, plan, dialect));
}

export function compileInsertOrThrow(
  schema: Schema,
  name: string,
  input: unknown,
  meta: Sql.Row,
): Sql.SQL {
  return orThrow(Write.compileInsert(schema, name, input, meta));
}

/** A document patch is implemented as a validated read/merge/replace within one transaction. */
export function compileReplaceOrThrow(
  schema: Schema,
  name: string,
  id: string,
  input: unknown,
): Sql.SQL {
  return orThrow(Write.compileReplace(schema, name, id, input));
}

export function compileDeleteOrThrow(schema: Schema, name: string, id: string): Sql.SQL {
  return orThrow(Write.compileDelete(schema, name, id));
}

export function decodeOrThrow(schema: Schema, plan: SelectPlan, rows: Sql.Row[]): unknown {
  return orThrow(Decode.decode(schema, plan, rows));
}

// Legacy aliases: the names `platform/`, `scripts/explain.ts` and `tests/core_test.ts` still import.
// Both the raising behaviour and the messages are unchanged from before the port.
export {
  compileDDLOrThrow as compileDDL,
  compileDeleteOrThrow as compileDelete,
  compileInsertOrThrow as compileInsert,
  compileReplaceOrThrow as compileReplace,
  compileSelectOrThrow as compileSelect,
  decodeOrThrow as decode,
  quoteOrThrow as quote,
  tableForOrThrow as tableFor,
};
