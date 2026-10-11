/**
 * The typed HTTP client (plan item 10, work 4).
 *
 * `call` returns `Effect<R, ClientError>` instead of a promise that rejects with an untyped
 * `Error`: a non-2xx answer becomes a `RemoteError` carrying the status (and the server's tag once
 * item 22 starts sending one), which is the one error this module can produce in the *caller's*
 * process. A transport failure — DNS, a refused connection, the 30 s timeout firing — stays a
 * defect, exactly as it was an unhandled rejection before the port: `core/errors.ts`'s
 * `ClientError` is `RemoteError` alone, and widening that taxonomy belongs to the item that owns
 * the file.
 *
 * ## Trace ids
 *
 * Every request carries `X-Trace-Id`: the `traceId` argument when the caller passes one, verbatim,
 * otherwise a fresh id from `newTraceId` (default `crypto.randomUUID()`). The server judges the id
 * once, at ingress (`platform/http/trace.ts`): an id of 1–128 characters from `[A-Za-z0-9._:-]` is
 * used as the request's trace across the server and the reader process (`http`, `handler`, `sql`,
 * `tx` events and logs); anything else is replaced by a server-generated id, never refused. The
 * response's `X-Trace-Id` always names the id the request ran under. A custom `newTraceId` should
 * therefore return ids inside that bound, or its ids will be replaced.
 *
 * The argument positions and the default generator are a stable API (item 34): later items add
 * behind them, they do not move them.
 */
import { Cause, Effect, Exit } from "effect";
import { type ClientError, RemoteError } from "../core/errors.ts";
import type { ArgsOf, Functions, Kind, Names, ResultOf } from "./functions.ts";

/** Reads whatever the server put in `error`: a bare string today, a tagged object after item 22. */
function remoteFailure(status: number, body: unknown): RemoteError {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error) return new RemoteError({ status, message: error });
  if (error && typeof error === "object") {
    const { tag, message } = error as { tag?: unknown; message?: unknown };
    return new RemoteError({
      status,
      remoteTag: typeof tag === "string" ? tag : undefined,
      message: typeof message === "string" && message ? message : `HTTP ${status}`,
    });
  }
  return new RemoteError({ status, message: `HTTP ${status}` });
}

export function createClient<F extends Functions>(
  baseURL: string,
  appId: string,
  token: string,
  newTraceId: () => string = () => crypto.randomUUID(),
) {
  function call<K extends Kind, N extends Names<F, K>>(
    kind: K,
    name: N,
    args: ArgsOf<F[N]>,
    traceId?: string,
  ): Effect.Effect<ResultOf<F[N]>, ClientError> {
    const url = `${baseURL}/apps/${encodeURIComponent(appId)}/${kind}/${encodeURIComponent(name)}`;
    return Effect.gen(function* () {
      // The timeout signal is created when the effect runs, not when it is described.
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-trace-id": traceId ?? newTraceId(),
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30_000),
        })
      );
      const body = yield* Effect.promise(() => response.json() as Promise<{ result?: unknown }>);
      if (!response.ok) return yield* remoteFailure(response.status, body);
      return body.result as ResultOf<F[N]>;
    });
  }
  return {
    query: <N extends Names<F, "query">>(name: N, args: ArgsOf<F[N]>, traceId?: string) =>
      call("query", name, args, traceId),
    mutation: <N extends Names<F, "mutation">>(name: N, args: ArgsOf<F[N]>, traceId?: string) =>
      call("mutation", name, args, traceId),
  };
}

/**
 * TEMPORARY BRIDGE (item 10): the promise-shaped client its not-yet-ported callers still use —
 * `scripts/demo.ts` (unowned by any plan item) and `tests/integration.ts` (owned by item 25). It
 * runs the effect and rejects with the `RemoteError` itself, which carries the same message the
 * pre-port client threw.
 */
export function createPromiseClient<F extends Functions>(
  baseURL: string,
  appId: string,
  token: string,
  newTraceId: () => string = () => crypto.randomUUID(),
) {
  const client = createClient<F>(baseURL, appId, token, newTraceId);
  const run = async <A>(effect: Effect.Effect<A, ClientError>): Promise<A> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.squash(exit.cause);
    throw failure instanceof Error ? failure : new Error(String(failure));
  };
  return {
    query: <N extends Names<F, "query">>(name: N, args: ArgsOf<F[N]>, traceId?: string) =>
      run(client.query(name, args, traceId)),
    mutation: <N extends Names<F, "mutation">>(name: N, args: ArgsOf<F[N]>, traceId?: string) =>
      run(client.mutation(name, args, traceId)),
  };
}
