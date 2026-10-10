import { parseObject, type Fields, type Infer, type Schema } from "./schema.ts";
import type { ReadDB, WriteDB } from "./db.ts";
export type Kind = "query" | "mutation";
export type Definition<K extends Kind, A, R> = {
  kind: K;
  invoke(db: unknown, input: unknown): Promise<R>;
  readonly _args?: A;
  readonly _result?: R;
};
export type AnyDefinition = Definition<Kind, unknown, unknown>;
export type Functions = Record<string, AnyDefinition>;
export type ArgsOf<F> = F extends Definition<Kind, infer A, unknown> ? A : never;
export type ResultOf<F> = F extends Definition<Kind, unknown, infer R> ? R : never;
export type Names<F extends Functions, K extends Kind> = {
  [N in keyof F]: F[N]["kind"] extends K ? N : never
}[keyof F] & string;

export function defineFunctions<S extends Schema>(_schema: S) {
  function build<K extends Kind, A extends Fields, R>(kind: K, config: {
    args: A;
    handler: (ctx: { db: K extends "query" ? ReadDB<S> : WriteDB<S> }, args: Infer<A>) => R | Promise<R>;
  }): Definition<K, Infer<A>, R> {
    return {
      kind,
      async invoke(db, input) {
        // Type erasure is limited to this runtime boundary. The router chooses the adapter.
        return await config.handler({ db } as Parameters<typeof config.handler>[0], parseObject(config.args, input));
      },
    };
  }
  return {
    query: <A extends Fields, R>(config: {
      args: A; handler: (ctx: { db: ReadDB<S> }, args: Infer<A>) => R | Promise<R>;
    }) => build("query", config),
    mutation: <A extends Fields, R>(config: {
      args: A; handler: (ctx: { db: WriteDB<S> }, args: Infer<A>) => R | Promise<R>;
    }) => build("mutation", config),
  };
}
