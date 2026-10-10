// TEMPORARY SCAFFOLD for property-test experiment (item 12) — to be replaced by the real item 02 implementation. Do not build on this.

export class SchemaError extends Error {
  constructor(
    public path: string,
    public expected: string,
    public actual?: unknown,
  ) {
    super(`${path}: expected ${expected}${actual !== undefined ? ` but got ${JSON.stringify(actual)}` : ""}`);
    this.name = "SchemaError";
  }
}

export class IpcError extends Error {
  constructor(
    public tag: "MessageTooLarge" | "TruncatedMessage",
    message?: string,
  ) {
    super(message || tag);
    this.name = "IpcError";
  }
}

export class MoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveError";
  }
}
