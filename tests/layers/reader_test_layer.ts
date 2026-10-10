/**
 * `ReaderTest`: query handlers over the in-memory store (plan item 20, §1.2).
 *
 * Reads go to the same `MemoryStore` `StorageTest` writes, so one process can exercise the whole
 * read-after-write path with no child process and no DuckDB. The pipeline mirrors
 * `platform/duckdb.ts`'s `makeReader`:
 *
 * - a non-query definition is a defect (`HandlerKindMismatch`), as the router should have caught it;
 * - one query at a time, each inside its own read transaction whose `db` expires at the end
 *   (`ContextExpiredError({ context: "query" })` if a forked fiber keeps it);
 * - any write fails `QueryWriteAttemptError`;
 * - plans are validated by the engine's compiler in the `duckdb` dialect;
 * - anything outside `QueryError` from the handler is a defect, and a result that does not survive a
 *   JSON round-trip fails `ReaderError({ operation: "commit" })`.
 *
 * A query reads one snapshot of the committed contents, taken when its transaction begins, and never
 * sees a mutation that has not committed.
 */
import { Effect, Layer, Ref } from "effect";
import {
  type CompileError,
  ContextExpiredError,
  HandlerKindMismatch,
  type QueryError,
  QueryWriteAttemptError,
  ReaderError,
  type SchemaError,
} from "../../core/errors.ts";
import type { Schema } from "../../core/schema.ts";
import { Documents } from "../../sdk/db.ts";
import type { AnyDefinition } from "../../sdk/functions.ts";
import { type IdGen, Reader, type ReaderService, type Storage } from "../../platform/services.ts";
import {
  evaluateSelect,
  MemoryStore,
  MemoryStoreTest,
  StorageTestOn,
  type StorageTestOptions,
  type StoreContents,
} from "./storage_test_layer.ts";

/** Every `QueryError` tag, so a handler's erased failure channel narrows exactly as live. */
const QUERY_ERROR_TAGS: Record<QueryError["_tag"], true> = {
  SchemaError: true,
  CompileError: true,
  DecodeError: true,
  RuleError: true,
  NotFoundError: true,
  ContextExpiredError: true,
  QueryWriteAttemptError: true,
  ReaderError: true,
  QueueFullError: true,
};

function isQueryError(error: unknown): error is QueryError {
  if (typeof error !== "object" || error === null) return false;
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === "string" && Object.hasOwn(QUERY_ERROR_TAGS, tag);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface ReaderTestOptions {
  /** Stamped on `HandlerKindMismatch`, as the live reader stamps its app's id. Default `"test"`. */
  readonly appId?: string;
}

/** Builds the service over the `MemoryStore` in context. */
export function makeReaderTest(
  options: ReaderTestOptions = {},
): Effect.Effect<ReaderService, never, MemoryStore> {
  const appId = options.appId ?? "test";
  return Effect.gen(function* () {
    const { schema, state } = yield* MemoryStore;
    const lock = yield* Effect.makeSemaphore(1);

    const run = (
      definition: AnyDefinition,
      args: unknown,
      snapshot: StoreContents,
      context: { active: boolean },
    ) =>
      Effect.gen(function* () {
        const db = new Documents<Schema>((operation) =>
          Effect.suspend((): Effect.Effect<unknown, QueryError> => {
            if (!context.active) return Effect.fail(new ContextExpiredError({ context: "query" }));
            if (operation.kind !== "select") {
              return Effect.fail(
                new QueryWriteAttemptError({ operation: operation.kind, table: operation.table }),
              );
            }
            return evaluateSelect(schema, snapshot, operation, "duckdb");
          })
        );
        const result = yield* definition.invoke(db, args).pipe(
          Effect.catchAll((error) => isQueryError(error) ? Effect.fail(error) : Effect.die(error)),
        );
        return yield* Effect.try({
          try: (): unknown => JSON.parse(JSON.stringify(result ?? null)),
          catch: (cause) =>
            new ReaderError({
              operation: "commit",
              detail: `handler result is not JSON-serializable: ${messageOf(cause)}`,
              cause,
            }),
        });
      });

    return {
      query: (definition, args) =>
        definition.kind !== "query"
          ? Effect.die(new HandlerKindMismatch({ appId, expected: "query", actual: definition.kind }))
          : lock.withPermits(1)(
            Effect.acquireUseRelease(
              Effect.map(Ref.get(state), (snapshot) => ({ snapshot, context: { active: true } })),
              ({ snapshot, context }) => run(definition, args, snapshot, context),
              ({ context }) => Effect.sync(() => void (context.active = false)),
            ),
          ),
    };
  });
}

/** `Reader` over a `MemoryStore` provided elsewhere (normally the one `StorageTest` writes). */
export function ReaderTest(options: ReaderTestOptions = {}): Layer.Layer<Reader, never, MemoryStore> {
  return Layer.effect(Reader, makeReaderTest(options));
}

/**
 * `Storage` and `Reader` over one fresh `MemoryStore` for `schema`, which is exposed too: a query
 * sees exactly what the mutations before it committed.
 */
export function DocumentStoreTest(
  options: StorageTestOptions & ReaderTestOptions & { readonly schema: Schema },
): Layer.Layer<Storage | Reader | MemoryStore, CompileError | SchemaError, IdGen> {
  return Layer.provideMerge(
    Layer.merge(StorageTestOn(options), ReaderTest(options)),
    MemoryStoreTest(options.schema),
  );
}
