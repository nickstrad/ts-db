import { Database } from "../../../platform/sqlite_ffi/mod.ts";
Database.prototype.closeAsync = function () {
  console.log("FAULT: close rejected; database still open:", this.isOpen);
  return Promise.reject(new Error("injected close failure"));
};
await import("../../../tests/property/ffi_interrupt_test.ts");
