import { Effect } from "effect";
import { schema } from "../app/schema.ts";
import { withStorage } from "../sdk/schema.ts";
import { compileDDL, compileSelect } from "../platform/compiler.ts";
import { Documents, type SelectPlan } from "../sdk/db.ts";
let plan: SelectPlan;
// `Execute` is Effect-shaped since item 10, so the plan is captured by running the effect.
const db = new Documents<typeof schema>((op) =>
  Effect.sync(() => {
    plan = op as SelectPlan;
    return [];
  })
);
await Effect.runPromise(
  db.find("games", { status: "playing" }).sort("_creationTime", "desc").limit(20).collect(),
);
console.log("QUERY PLAN", JSON.stringify(plan!, null, 2));
for (const storage of ["columns", "json"] as const) {
  const physical = withStorage(schema, storage);
  console.log(`\n${storage.toUpperCase()} DDL\n${compileDDL(physical).join(";\n")};`);
  for (const dialect of ["sqlite", "duckdb"] as const) {
    console.log(dialect, JSON.stringify(compileSelect(physical, plan!, dialect), null, 2));
  }
}
