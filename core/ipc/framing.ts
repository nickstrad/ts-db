/**
 * Pure incremental decoder for the JSON-lines IPC framing used between the parent and the reader
 * child process. Takes string chunks (decoding from bytes happens at the stream boundary, in
 * `platform/ipc.ts`, not here) and buffers them into complete, newline-terminated lines.
 *
 * Rules (unchanged from the original `platform/ipc.ts` `lines()`):
 * - Empty lines are skipped.
 * - A buffer that grows past `maxBytes` without a newline fails with `IpcError("message-too-large")`.
 * - A non-empty trailing buffer at end-of-stream (`finish()`) fails with
 *   `IpcError("truncated-message")`.
 */
import { Either } from "effect";
import { IpcError } from "../errors.ts";

export interface Decoder {
  readonly push: (chunk: string) => Either.Either<string[], IpcError>;
  readonly finish: () => Either.Either<void, IpcError>;
}

export function decoder(maxBytes = 2_000_000): Decoder {
  let buffer = "";
  return {
    push(chunk: string): Either.Either<string[], IpcError> {
      buffer += chunk;
      const lines: string[] = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) lines.push(line);
      }
      if (buffer.length > maxBytes) {
        return Either.left(new IpcError({ reason: "message-too-large" }));
      }
      return Either.right(lines);
    },
    finish(): Either.Either<void, IpcError> {
      if (buffer.trim()) {
        return Either.left(new IpcError({ reason: "truncated-message" }));
      }
      return Either.right(undefined);
    },
  };
}
