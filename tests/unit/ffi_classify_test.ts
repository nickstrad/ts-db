/**
 * The statement classifier (FFI-05, `platform/sqlite_ffi/classify.ts`): every `Operation` shape the
 * SDK can produce, read off the SDK itself, and a property over generated `SelectPlan`s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Effect } from "effect";
import { classify, pathOf, type StatementClass } from "../../platform/sqlite_ffi/classify.ts";
import { Documents, type Filter, type Operation, type SelectPlan } from "../../sdk/db.ts";
import { schema } from "../../app/schema.ts";

/** Every operation a `Documents` method hands its executor, in call order. */
function captured(use: (db: Documents<typeof schema>) => Effect.Effect<unknown, unknown>): Operation[] {
  const seen: Operation[] = [];
  const db = new Documents<typeof schema>((operation) => {
    seen.push(operation);
    return Effect.succeed(operation.kind === "select" && operation.aggregate?.kind === "count" ? 0 : []);
  });
  Effect.runSync(Effect.ignore(use(db)));
  return seen;
}

test("classify: every operation the SDK produces", () => {
  // [description, what the app code does, expected class]
  const cases: [string, (db: Documents<typeof schema>) => Effect.Effect<unknown, unknown>, StatementClass][] =
    [
      // get(table, id) is the primary-key lookup: filters [{ _id eq }], limit 1, no aggregate.
      ["get by id", (db) => db.get("games", "g-1"), "bounded"],
      // find() with no filter scans the table.
      ["find().collect()", (db) => db.find("games").collect(), "unbounded"],
      ["find().first()", (db) => db.find("games").first(), "unbounded"],
      // An equality filter on an indexed non-key field is still a range of rows, not one.
      ["find({ status }) (indexed)", (db) => db.find("games", { status: "playing" }).collect(), "unbounded"],
      ["find().where(field)", (db) => db.find("games").where("xPlayer", "a").collect(), "unbounded"],
      ["find().gt(field)", (db) => db.find("moves").gt("moveNumber", 3).collect(), "unbounded"],
      [
        "find().sort().limit()",
        (db) => db.find("games").sort("_creationTime", "desc").limit(20).collect(),
        "unbounded",
      ],
      // `find({ _id })` is the same primary-key lookup as `get`, whatever else it filters or orders by.
      ["find({ _id }).collect()", (db) => db.find("games").where("_id", "g-1").collect(), "bounded"],
      [
        "find({ _id }).where().sort().limit()",
        (db) =>
          db.find("games").where("_id", "g-1").where("status", "won").sort("xPlayer").limit(5).collect(),
        "bounded",
      ],
      ["find({ _id }).first()", (db) => db.find("games").where("_id", "g-1").first(), "bounded"],
      // Aggregates are unbounded even with an _id filter (the rule is deliberately conservative).
      ["count()", (db) => db.find("games").count(), "unbounded"],
      ["find({ status }).count()", (db) => db.find("games", { status: "won" }).count(), "unbounded"],
      ["find({ _id }).count()", (db) => db.find("games").where("_id", "g-1").count(), "unbounded"],
      ["countBy()", (db) => db.find("games", { status: "won" }).countBy("winner"), "unbounded"],
      [
        "find({ _id }).countBy()",
        (db) => db.find("games").where("_id", "g-1").countBy("winner"),
        "unbounded",
      ],
      // Writes are bounded by kind.
      [
        "insert",
        (db) =>
          db.insert("games", {
            xPlayer: "a",
            oPlayer: "b",
            board: Array(9).fill(null),
            turn: "X",
            status: "playing",
            winner: null,
          }),
        "bounded",
      ],
      ["patch", (db) => db.patch("games", "g-1", { status: "won" }), "bounded"],
      ["delete", (db) => db.delete("games", "g-1"), "bounded"],
    ];
  const kinds = new Set<string>();
  for (const [name, use, expected] of cases) {
    const operations = captured(use);
    assert.equal(operations.length, 1, `${name}: one operation`);
    const [operation] = operations;
    kinds.add(operation.kind === "select" ? `select/${operation.aggregate?.kind ?? "rows"}` : operation.kind);
    assert.equal(classify(operation), expected, `${name}: ${JSON.stringify(operation)}`);
    assert.equal(pathOf(classify(operation)), expected === "bounded" ? "blocking" : "nonblocking", name);
  }
  // Every operation kind and every select shape the SDK has was exercised above.
  assert.deepEqual(
    [...kinds].sort(),
    ["delete", "insert", "patch", "select/count", "select/countBy", "select/rows"],
  );
});

test("classify: hand-built shapes at the edges of the rule", () => {
  const base: SelectPlan = { kind: "select", table: "games", filters: [], limit: 100 };
  const id = (op: Filter["op"], value: unknown = "g-1"): Filter => ({ field: "_id", op, value });
  // `_id > ?` is a range, not a lookup.
  assert.equal(classify({ ...base, filters: [id("gt")] }), "unbounded");
  // A field merely named like `_id` does not count.
  assert.equal(classify({ ...base, filters: [{ field: "_id_", op: "eq", value: "x" }] }), "unbounded");
  assert.equal(classify({ ...base, filters: [{ field: "id", op: "eq", value: "x" }] }), "unbounded");
  // Position among the filters does not matter; one _id equality is enough.
  assert.equal(
    classify({ ...base, filters: [{ field: "status", op: "eq", value: "won" }, id("gt"), id("eq")] }),
    "bounded",
  );
  // An explicit `aggregate: undefined` is "no aggregate".
  assert.equal(classify({ ...base, filters: [id("eq")], aggregate: undefined }), "bounded");
  // Order and limit never change the class.
  assert.equal(
    classify({ ...base, filters: [id("eq")], order: { field: "xPlayer", direction: "desc" }, limit: 1000 }),
    "bounded",
  );
  assert.equal(classify({ ...base, order: { field: "_id", direction: "asc" }, limit: 1 }), "unbounded");
});

const filterArb: fc.Arbitrary<Filter> = fc.record({
  field: fc.constantFrom("_id", "status", "xPlayer", "moveNumber", "_creationTime", "id", "_id_"),
  op: fc.constantFrom("eq" as const, "gt" as const),
  value: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
});

const selectArb: fc.Arbitrary<SelectPlan> = fc.record(
  {
    kind: fc.constant("select" as const),
    table: fc.constantFrom("games", "moves"),
    filters: fc.array(filterArb, { maxLength: 6 }),
    order: fc.record({
      field: fc.constantFrom("_id", "status", "moveNumber"),
      direction: fc.constantFrom("asc" as const, "desc" as const),
    }),
    limit: fc.integer({ min: 1, max: 1000 }),
    // "No aggregate" both as an absent key (below) and as an explicit `undefined`.
    aggregate: fc.oneof(
      { arbitrary: fc.constant(undefined), weight: 2 },
      { arbitrary: fc.constant({ kind: "count" as const }), weight: 1 },
      {
        arbitrary: fc.record({
          kind: fc.constant("countBy" as const),
          field: fc.constantFrom("status", "winner"),
        }),
        weight: 1,
      },
    ),
  },
  { requiredKeys: ["kind", "table", "filters", "limit"] },
);

test("classify property: bounded ⇔ (_id eq filter present ∧ no aggregate)", () => {
  const seen = { bounded: 0, unbounded: 0 };
  fc.assert(
    fc.property(selectArb, (plan) => {
      const expected = plan.filters.some((f) => f.field === "_id" && f.op === "eq") &&
        plan.aggregate === undefined;
      const actual = classify(plan);
      seen[actual]++;
      assert.equal(actual === "bounded", expected, JSON.stringify(plan));
    }),
    { numRuns: 2000 },
  );
  // The generator reaches both sides of the rule (each is well over 100 of 2000 runs).
  assert.ok(seen.bounded > 100 && seen.unbounded > 100, JSON.stringify(seen));
});

test("classify property: writes are bounded whatever they carry", () => {
  const write: fc.Arbitrary<Operation> = fc.oneof(
    fc.record({ kind: fc.constant("insert" as const), table: fc.string(), value: fc.anything() }),
    fc.record({
      kind: fc.constant("patch" as const),
      table: fc.string(),
      id: fc.string(),
      value: fc.anything(),
    }),
    fc.record({ kind: fc.constant("delete" as const), table: fc.string(), id: fc.string() }),
  );
  fc.assert(fc.property(write, (operation) => classify(operation) === "bounded"), { numRuns: 500 });
});
