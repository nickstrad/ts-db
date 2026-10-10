/**
 * Handler declaration (plan item 10).
 *
 * A handler is an `Effect`, not an `async` function: it returns a description of the work, and the
 * platform decides when to run it. Two consequences app authors see directly:
 *
 * 1. Argument parsing moved into the error channel. `invoke` is
 *    `Effect<R, E | SchemaError>` — `core/schema.parseObject` returns an `Either`, which *is* an
 *    `Effect` in Effect 3, so the parse simply flat-maps into the handler. Nothing throws.
 * 2. A handler's own failures are typed. `app/functions.ts` fails with `MoveError`,
 *    `NotFoundError` and `ConflictError` instead of `throw new Error("Not your turn")`, and `E`
 *    carries them all the way out to the caller.
 *
 * Note on the type parameter order: `Definition` gained a fourth parameter for the handler's error
 * channel, after `R`. `ArgsOf`/`ResultOf`/`Names` are unchanged, and `tests/types.ts` still
 * infers (and still rejects) exactly what it did before the port.
 */
import { Cause, Effect, Exit } from "effect";
import { SchemaError } from "../core/errors.ts";
import { type Fields, type Infer, parseObject, type Schema } from "../core/schema.ts";
import type { ReadDB, WriteDB } from "./db.ts";
import { formatSchemaError } from "./schema.ts";

export type Kind = "query" | "mutation";
export type Definition<K extends Kind, A, R, E = never> = {
  kind: K;
  invoke(db: unknown, input: unknown): Effect.Effect<R, E | SchemaError>;
  readonly _args?: A;
  readonly _result?: R;
};
export type AnyDefinition = Definition<Kind, unknown, unknown, unknown>;
export type Functions = Record<string, AnyDefinition>;
export type ArgsOf<F> = F extends Definition<Kind, infer A, unknown, unknown> ? A : never;
export type ResultOf<F> = F extends Definition<Kind, unknown, infer R, unknown> ? R : never;
export type Names<F extends Functions, K extends Kind> =
  & {
    [N in keyof F]: F[N]["kind"] extends K ? N : never;
  }[keyof F]
  & string;

export function defineFunctions<S extends Schema>(_schema: S) {
  function build<K extends Kind, A extends Fields, R, E>(kind: K, config: {
    args: A;
    handler: (
      ctx: { db: K extends "query" ? ReadDB<S> : WriteDB<S> },
      args: Infer<A>,
    ) => Effect.Effect<R, E>;
  }): Definition<K, Infer<A>, R, E> {
    return {
      kind,
      invoke(db, input) {
        // `parseObject` is `Either`-returning, and an `Either` is an `Effect` whose error channel
        // is its left: the schema failure and the handler's own failures share one channel.
        // Type erasure is limited to this runtime boundary. The router chooses the adapter.
        return Effect.flatMap(
          parseObject(config.args, input),
          (args) => config.handler({ db } as Parameters<typeof config.handler>[0], args),
        );
      },
    };
  }
  return {
    query: <A extends Fields, R, E>(config: {
      args: A;
      handler: (ctx: { db: ReadDB<S> }, args: Infer<A>) => Effect.Effect<R, E>;
    }) => build("query", config),
    mutation: <A extends Fields, R, E>(config: {
      args: A;
      handler: (ctx: { db: WriteDB<S> }, args: Infer<A>) => Effect.Effect<R, E>;
    }) => build("mutation", config),
  };
}

/**
 * TEMPORARY BRIDGE (item 10): removed by items 15/16, which make `Storage.mutation` and
 * `Reader.query` return effects and therefore never need a promise.
 *
 * Until then `platform/sqlite.ts` and `platform/duckdb.ts` are still promise-shaped, so they run
 * the handler effect here. The rejection is deliberately the *same* `Error` the pre-port code
 * threw — `formatSchemaError` renders a `SchemaError` back into its legacy message, a tagged error
 * that carries a message is rethrown as itself — so `platform/server.ts`'s `e.message` body and
 * every message regex in `tests/core_test.ts` are unchanged by this commit. Item 22 replaces this
 * rendering with the real status mapping in `core/errors.toHttpStatus`.
 */
export async function runHandlerAsPromise(
  definition: AnyDefinition,
  db: unknown,
  args: unknown,
): Promise<unknown> {
  const exit = await Effect.runPromiseExit(definition.invoke(db, args));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.squash(exit.cause);
  if (failure instanceof SchemaError) throw formatSchemaError(failure);
  if (failure instanceof Error) throw failure.message ? failure : new Error(failure.name, { cause: failure });
  throw new Error(String(failure));
}
