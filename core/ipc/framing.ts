// TEMPORARY SCAFFOLD for property-test experiment (item 12) — to be replaced by the real item 05 implementation. Do not build on this.

import { IpcError } from "../errors.ts";
import type { Either } from "../schema.ts";
import { Left, Right } from "../schema.ts";

export type Decoder = {
  push(chunk: string): Either<IpcError, string[]>;
  finish(): Either<IpcError, void>;
};

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

export function decoder(maxBytes: number = MAX_BYTES): Decoder {
  let buffer = "";
  let totalBytes = 0;

  return {
    push(chunk: string): Either<IpcError, string[]> {
      buffer += chunk;
      totalBytes += new TextEncoder().encode(chunk).length;

      if (totalBytes > maxBytes) {
        return Left(new IpcError("MessageTooLarge"));
      }

      const messages: string[] = [];
      const lines = buffer.split("\n");

      // Keep the last line in the buffer (it may be incomplete)
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        // Don't trim, just skip empty lines (lines with only whitespace should be skipped)
        if (line.trim().length > 0) {
          messages.push(line);
        }
      }

      // Update buffer with the last (potentially incomplete) line
      buffer = lines[lines.length - 1];

      return Right(messages);
    },

    finish(): Either<IpcError, void> {
      // If there's a non-empty trailing buffer, it's a truncated message
      if (buffer.trim().length > 0) {
        return Left(new IpcError("TruncatedMessage"));
      }
      return Right(undefined);
    },
  };
}
