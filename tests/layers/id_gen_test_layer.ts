/**
 * `IdGenTest`: deterministic document ids (plan item 20, §1.2).
 *
 * Ids are `id-1`, `id-2`, … — the same sequence `tests/core_test.ts`'s pre-port fixture injected
 * into `SQLiteWriter`. The counter belongs to one *build* of the layer, not to the module: every
 * `Effect.provide(IdGenTest)` starts again at `id-1`, which is what lets two apps in one test
 * produce colliding ids on purpose ("each app file has its own data, even when IDs collide").
 */
import { Effect, Layer } from "effect";
import { IdGen, type IdGenService } from "../../platform/services.ts";

/** A fresh counter: `${prefix}1`, `${prefix}2`, … Each call to this effect starts a new sequence. */
export function makeIdGenTest(prefix = "id-"): Effect.Effect<IdGenService> {
  return Effect.sync(() => {
    let n = 0;
    return { next: Effect.sync(() => `${prefix}${++n}`) };
  });
}

/** `IdGen` counting from `${prefix}1`. */
export function IdGenTestWith(prefix: string): Layer.Layer<IdGen> {
  return Layer.effect(IdGen, makeIdGenTest(prefix));
}

/** `IdGen` counting `id-1`, `id-2`, … per layer build. */
export const IdGenTest: Layer.Layer<IdGen> = IdGenTestWith("id-");
