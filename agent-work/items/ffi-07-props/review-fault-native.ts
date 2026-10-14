import { Database, loadLibrary } from "../../../platform/sqlite_ffi/mod.ts";
const library = loadLibrary();
Object.defineProperty(library, "symbols", {
  value: { ...library.symbols, sqlite3_interrupt: () => {} },
});
console.log("FAULT: native sqlite3_interrupt disabled; actual SQLite step can remain running");
const close = Database.prototype.closeAsync;
Database.prototype.closeAsync = function () {
  console.log("FAULT: entered cleanup; native execution still in flight:", this.inFlight);
  return close.call(this);
};
await import("../../../tests/property/ffi_interrupt_test.ts");
