/**
 * The test layers (plan item 20): in-memory doubles for every service whose live layer touches a
 * file, a process, the network or the wall clock.
 *
 * | Service       | Double                                  | Read-back / control tag     |
 * | ------------- | --------------------------------------- | --------------------------- |
 * | `Storage`     | `StorageTest` (in-memory document store) | `MemoryStore`               |
 * | `Reader`      | `ReaderTest` (same store)               | `MemoryStore`               |
 * | `ObjectStore` | `ObjectStoreTest` (failure injection)   | `ObjectStoreTestControl`    |
 * | `EventSink`   | `EventSinkTest`                         | `TestEvents`                |
 * | `IdGen`       | `IdGenTest` (`id-1`, `id-2`, …)         | —                           |
 * | `Clock`       | Effect's `TestClock`, via `TestContext` | `TestClock.adjust` / `setTime` |
 * | `Config`      | `ConfigTest()` from `platform/config.ts` | —                           |
 *
 * `TestLayer` is the default stack `tests/helpers/run.ts` provides to every test: everything above
 * except `Storage`/`Reader`, which need a schema — add `StorageTest({ schema })` or
 * `DocumentStoreTest({ schema })` per test. None of these layers opens a file or spawns a process.
 */
import { Layer, TestContext, type TestServices } from "effect";
import { ConfigTest } from "../../platform/config.ts";
import type { Config, EventSink, IdGen, ObjectStore } from "../../platform/services.ts";
import { EventSinkTest, type TestEvents } from "./event_sink_test_layer.ts";
import { IdGenTest } from "./id_gen_test_layer.ts";
import { ObjectStoreTest, type ObjectStoreTestControl } from "./object_store_test_layer.ts";

export * from "./event_sink_test_layer.ts";
export * from "./id_gen_test_layer.ts";
export * from "./object_store_test_layer.ts";
export * from "./reader_test_layer.ts";
export * from "./storage_test_layer.ts";

/** What `TestLayer` provides. */
export type DefaultTestServices =
  | IdGen
  | EventSink
  | TestEvents
  | ObjectStore
  | ObjectStoreTestControl
  | Config
  | TestServices.TestServices;

/**
 * The default test stack. `TestContext` swaps Effect's `Clock` for `TestClock` (time starts at 0
 * and moves only when a test moves it), so `_creationTime` and every event timestamp are
 * deterministic. Each build is fresh: ids restart at `id-1`, and the event log and object store
 * start empty.
 */
export const TestLayer: Layer.Layer<DefaultTestServices> = Layer.mergeAll(
  IdGenTest,
  EventSinkTest,
  ObjectStoreTest(),
  ConfigTest(),
  TestContext.TestContext,
);
