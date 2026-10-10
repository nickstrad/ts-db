/**
 * Pure incremental decoder for the JSON-lines IPC framing used between the parent and the reader
 * child process. Takes string chunks (decoding from bytes happens at the stream boundary, in
 * `platform/ipc.ts`, not here) and buffers them into complete, newline-terminated lines.
 *
 * Rules (unchanged from the original `platform/ipc.ts` `lines()`):
 * - Empty lines are skipped.
 * - A buffer that grows past `maxBytes` without a newline fails with
 *   `IpcError({ reason: "message-too-large", detail: "IPC message too large" })`. The error is
 *   deferred to the next `push()`/`finish()` call so that complete lines extracted from the
 *   offending chunk are delivered first — matching the legacy order (yield lines, then throw).
 * - A non-empty trailing buffer at end-of-stream (`finish()`) fails with
 *   `IpcError({ reason: "truncated-message", detail: "Truncated IPC message" })`.
 *
 * The human-readable text lives in the structured `detail` field (per the error-taxonomy rule
 * that errors carry structured fields, not pre-formatted messages); item 17 ports the consumers
 * to typed matching on `reason`/`detail`.
 */
import { Either } from "effect";
import { IpcError } from "../errors.ts";

export interface Decoder {
  readonly push: (chunk: string) => Either.Either<string[], IpcError>;
  readonly finish: () => Either.Either<void, IpcError>;
}

/**
 * @param maxBytes — legacy-faithful limit, measured in UTF-16 code units (`String.length`), not
 * decoded bytes. The name is kept as-is to match the original check exactly.
 */
export function decoder(maxBytes = 2_000_000): Decoder {
  let buffer = "";
  // Latched oversize failure. Legacy `lines()` yielded the complete lines extracted from an
  // offending chunk before throwing on its oversize remainder; latching here and surfacing the
  // error on the next `push()`/`finish()` reproduces that observable order.
  let failed: IpcError | undefined;
  return {
    push(chunk: string): Either.Either<string[], IpcError> {
      if (failed) return Either.left(failed);
      buffer += chunk;
      const lines: string[] = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) lines.push(line);
      }
      if (buffer.length > maxBytes) {
        failed = new IpcError({ reason: "message-too-large", detail: "IPC message too large" });
      }
      return Either.right(lines);
    },
    finish(): Either.Either<void, IpcError> {
      if (failed) return Either.left(failed);
      if (buffer.trim()) {
        return Either.left(
          new IpcError({ reason: "truncated-message", detail: "Truncated IPC message" }),
        );
      }
      return Either.right(undefined);
    },
  };
}
