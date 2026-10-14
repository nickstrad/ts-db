import { Statement } from "../../../platform/sqlite_ffi/mod.ts";
const original = Statement.prototype.getAsync;
Statement.prototype.getAsync = function (...args) {
  if (this.sql === "SELECT 42 AS x") {
    console.log("FAULT: recovery probe remains pending with a live operation");
    return new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  return original.apply(this, args);
};
await import("../../../tests/property/ffi_interrupt_test.ts");
