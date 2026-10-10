import type { Body, Document, Schema } from "./schema.ts";

/** This is the intermediate representation. There is no SQL in the public SDK. */
export type Filter = { field: string; op: "eq" | "gt"; value: unknown };
export type SelectPlan = {
  kind: "select";
  table: string;
  filters: Filter[];
  order?: { field: string; direction: "asc" | "desc" };
  limit: number;
  aggregate?: { kind: "count" } | { kind: "countBy"; field: string };
};
export type Operation = SelectPlan
  | { kind: "insert"; table: string; value: unknown }
  | { kind: "patch"; table: string; id: string; value: unknown }
  | { kind: "delete"; table: string; id: string };
export type Execute = (operation: Operation) => Promise<unknown>;
type ScalarKey<T> = { [K in keyof T]: T[K] extends string | number | boolean | null ? K : never }[keyof T] & string;
type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T] & string;
export type Equality<T> = Partial<Pick<T, ScalarKey<T>>>;

export class Find<T> {
  constructor(private execute: Execute, readonly plan: SelectPlan) {}
  where<K extends ScalarKey<T>>(field: K, value: T[K]): Find<T> {
    return new Find(this.execute, { ...this.plan, filters: [...this.plan.filters, { field, op: "eq", value }] });
  }
  gt<K extends NumericKey<T>>(field: K, value: number): Find<T> {
    return new Find(this.execute, { ...this.plan, filters: [...this.plan.filters, { field, op: "gt", value }] });
  }
  sort(field: ScalarKey<T>, direction: "asc" | "desc" = "asc"): Find<T> {
    return new Find(this.execute, { ...this.plan, order: { field, direction } });
  }
  limit(limit: number): Find<T> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Limit must be 1..1000");
    return new Find(this.execute, { ...this.plan, limit });
  }
  async collect(): Promise<T[]> { return await this.execute(this.plan) as T[]; }
  async first(): Promise<T | null> { return (await this.limit(1).collect())[0] ?? null; }
  async count(): Promise<number> {
    return await this.execute({ ...this.plan, order: undefined, aggregate: { kind: "count" } }) as number;
  }
  async countBy<K extends ScalarKey<T>>(field: K): Promise<{ value: T[K]; count: number }[]> {
    return await this.execute({ ...this.plan, order: undefined, aggregate: { kind: "countBy", field } }) as
      { value: T[K]; count: number }[];
  }
}

export interface ReadDB<S extends Schema> {
  get<K extends keyof S & string>(table: K, id: string): Promise<Document<S, K> | null>;
  find<K extends keyof S & string>(table: K, where?: Equality<Document<S, K>>): Find<Document<S, K>>;
}
export interface WriteDB<S extends Schema> extends ReadDB<S> {
  insert<K extends keyof S & string>(table: K, value: Body<S, K>): Promise<string>;
  patch<K extends keyof S & string>(table: K, id: string, value: Partial<Body<S, K>>): Promise<void>;
  delete<K extends keyof S & string>(table: K, id: string): Promise<void>;
}

/** The runtime injects an executor. App code only receives one of the interfaces. */
export class Documents<S extends Schema> implements WriteDB<S> {
  constructor(private execute: Execute) {}
  find<K extends keyof S & string>(table: K, where: Equality<Document<S, K>> = {}): Find<Document<S, K>> {
    return new Find(this.execute, {
      kind: "select", table, limit: 100,
      filters: Object.entries(where).map(([field, value]) => ({ field, op: "eq", value })),
    });
  }
  async get<K extends keyof S & string>(table: K, id: string): Promise<Document<S, K> | null> {
    const rows = await this.execute({
      kind: "select", table, filters: [{ field: "_id", op: "eq", value: id }], limit: 1,
    }) as Document<S, K>[];
    return rows[0] ?? null;
  }
  async insert<K extends keyof S & string>(table: K, value: Body<S, K>): Promise<string> {
    return await this.execute({ kind: "insert", table, value }) as string;
  }
  async patch<K extends keyof S & string>(table: K, id: string, value: Partial<Body<S, K>>): Promise<void> {
    await this.execute({ kind: "patch", table, id, value });
  }
  async delete<K extends keyof S & string>(table: K, id: string): Promise<void> {
    await this.execute({ kind: "delete", table, id });
  }
}
