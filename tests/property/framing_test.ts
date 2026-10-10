// Property tests for core/ipc/framing.ts JSON-lines decoder
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "npm:fast-check";
import { decoder } from "../../core/ipc/framing.ts";
import { seed } from "./arbitraries.ts";

Deno.test(`framing properties (seed: ${seed})`, async (t) => {
  // Property 1: for arbitrary message lists and arbitrary chunk splits, the decoder yields exactly the original non-empty messages
  await t.step("chunk-split invariance: decoder yields original messages", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (messages) => {
          // Filter out messages with newlines
          const withoutNewlines = messages.filter((m) => !m.includes("\n"));
          // Only keep non-empty (after trim) messages
          const cleanMessages = withoutNewlines.filter((m) => m.trim().length > 0);
          if (cleanMessages.length === 0) return true;

          // Concatenate with newlines (keep original, don't trim)
          const fullText = cleanMessages.join("\n") + "\n";

          // Try arbitrary chunk splits using random chunk sizes
          let pos = 0;
          const dec = decoder();
          const collectedMessages: string[] = [];

          while (pos < fullText.length) {
            // Generate a random chunk size between 1 and remaining length
            const remaining = fullText.length - pos;
            const chunkSize = Math.floor(Math.random() * remaining) + 1;
            const chunk = fullText.substring(pos, pos + chunkSize);

            const result = dec.push(chunk);
            assertEquals(result.tag, "Right", "push should not error with valid input");
            if (result.tag === "Right") {
              collectedMessages.push(...result.value);
            }
            pos += chunkSize;
          }

          // Finish the decoder
          const finishResult = dec.finish();
          assertEquals(finishResult.tag, "Right", "finish should succeed with complete messages");

          // We should have collected the original messages
          assertEquals(collectedMessages, cleanMessages, "Messages should be reconstructed exactly");
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 2: push never throws
  await t.step("push never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (chunk) => {
        const dec = decoder();
        let threw = false;
        try {
          dec.push(chunk);
        } catch (_e) {
          threw = true;
        }
        assertEquals(threw, false, "push should never throw");
      }),
      { numRuns: 200 },
    );
  });

  // Property 3: total bytes exceeding the cap always yields MessageTooLarge
  await t.step("exceeding byte cap yields MessageTooLarge", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (maxBytes) => {
          const dec = decoder(maxBytes);
          const largeString = "x".repeat(maxBytes + 1);

          const result = dec.push(largeString);
          assertEquals(result.tag, "Left", "Should fail when exceeding max bytes");
          if (result.tag === "Left") {
            assertEquals(result.value.tag, "MessageTooLarge", "Error should be MessageTooLarge");
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 4: empty lines are skipped
  await t.step("empty lines are skipped", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (messages) => {
          // Create text with some empty lines
          const cleanMessages = messages.filter((m) => m.trim().length > 0);
          const parts = cleanMessages.flatMap((m) => [m, ""]);
          const text = parts.join("\n") + "\n";

          const dec = decoder();
          const result = dec.push(text);
          assertEquals(result.tag, "Right");

          if (result.tag === "Right") {
            // Empty lines should not appear in result
            assertEquals(
              result.value.every((msg) => msg.trim().length > 0),
              true,
              "All messages should be non-empty",
            );
          }

          dec.finish();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 5: non-empty trailing buffer at end-of-stream fails with TruncatedMessage
  await t.step("truncated message at end fails", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("\n")),
        (incomplete) => {
          const dec = decoder();
          dec.push(incomplete); // No newline, so incomplete

          const result = dec.finish();
          assertEquals(result.tag, "Left", "finish should fail for incomplete message");
          if (result.tag === "Left") {
            assertEquals(result.value.tag, "TruncatedMessage", "Error should be TruncatedMessage");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 6: complete messages don't cause TruncatedMessage
  await t.step("complete messages don't fail on finish", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (messages) => {
          const cleanMessages = messages.filter((m) => !m.includes("\n"));
          const text = cleanMessages.join("\n") + "\n";

          const dec = decoder();
          dec.push(text);
          const result = dec.finish();
          assertEquals(result.tag, "Right", "finish should succeed for complete messages");
        },
      ),
      { numRuns: 100 },
    );
  });
});
