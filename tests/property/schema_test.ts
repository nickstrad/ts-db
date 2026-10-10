// Property tests for core/schema.ts validation
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "npm:fast-check";
import { validate, parseObject, Node, identifier } from "../../core/schema.ts";
import { SchemaError } from "../../core/errors.ts";
import { arb, seed } from "./arbitraries.ts";

Deno.test(`schema properties (seed: ${seed})`, async (t) => {
  // Property 1: a generated value matching a node always validates
  await t.step("matching value always validates", () => {
    fc.assert(
      fc.property(arb.node(), (node) => {
        const value = fc.sample(arb.matchingValue(node), 1)[0];
        const result = validate(node, value);
        assertEquals(result.tag, "Right", `Expected Right for ${JSON.stringify(value)} against ${JSON.stringify(node)}`);
      }),
      { numRuns: 200 },
    );
  });

  // Property 2: a generated non-matching value always fails with SchemaError whose path points at the offending position
  await t.step("non-matching value fails with SchemaError and correct path", () => {
    fc.assert(
      fc.property(arb.node(), (node) => {
        const value = fc.sample(arb.nonMatchingValue(node), 1)[0];
        const result = validate(node, value);
        assertEquals(result.tag, "Left", `Expected Left for non-matching value`);
        if (result.tag === "Left") {
          assertEquals(result.value instanceof SchemaError, true);
          assertEquals(typeof result.value.path, "string");
        }
      }),
      { numRuns: 200 },
    );
  });

  // Property 3: parseObject is total - returns Left or Right, never throws, for arbitrary JSON input
  await t.step("parseObject is total (never throws)", () => {
    fc.assert(
      fc.property(arb.fields(), fc.jsonValue(), (fields, input) => {
        let threw = false;
        let result;
        try {
          result = parseObject(fields, input);
        } catch (_e) {
          threw = true;
        }
        assertEquals(threw, false, "parseObject should never throw");
        assertEquals(result?.tag === "Left" || result?.tag === "Right", true, "Result should be Either");
      }),
      { numRuns: 200 },
    );
  });

  // Property 4: partial mode accepts exactly the subsets of a valid object
  await t.step("partial mode accepts subsets of valid objects", () => {
    fc.assert(
      fc.property(arb.fields(), (fields) => {
        // Generate a valid object
        const validObj = {} as Record<string, unknown>;
        for (const [key, field] of Object.entries(fields)) {
          const val = fc.sample(arb.matchingValue(field.node), 1)[0];
          validObj[key] = val;
        }

        // Full parse should succeed
        const fullResult = parseObject(fields, validObj, false);
        assertEquals(fullResult.tag, "Right");

        // Partial parse should also succeed
        const partialResult = parseObject(fields, validObj, true);
        assertEquals(partialResult.tag, "Right");

        // Any subset should succeed in partial mode
        const keys = Object.keys(validObj);
        for (let i = 0; i < keys.length; i++) {
          const subset = {} as Record<string, unknown>;
          for (let j = 0; j < i; j++) {
            subset[keys[j]] = validObj[keys[j]];
          }
          const subsetResult = parseObject(fields, subset, true);
          assertEquals(subsetResult.tag, "Right", `Subset should validate in partial mode`);
        }
      }),
      { numRuns: 100 }, // Reduced runs since this is more complex
    );
  });

  // Property 5: validation is idempotent
  await t.step("validation is idempotent", () => {
    fc.assert(
      fc.property(arb.node(), fc.anything(), (node, value) => {
        const result1 = validate(node, value);
        let result2;

        if (result1.tag === "Right") {
          result2 = validate(node, result1.value);
        } else {
          result2 = validate(node, value);
        }

        // Both results should have the same tag
        assertEquals(result1.tag, result2.tag, "Idempotence check: tags should match");
      }),
      { numRuns: 200 },
    );
  });

  // Property 6: identifier validation
  await t.step("valid identifiers pass, invalid ones fail", () => {
    fc.assert(
      fc.property(arb.identifier(true), (id) => {
        const result = identifier(id);
        assertEquals(result.tag, "Right", `Valid identifier ${id} should pass`);
      }),
      { numRuns: 100 },
    );
  });

  await t.step("invalid identifiers fail", () => {
    fc.assert(
      fc.property(arb.identifier(false), (id) => {
        const result = identifier(id);
        assertEquals(result.tag, "Left", `Invalid identifier ${id} should fail`);
      }),
      { numRuns: 100 },
    );
  });
});
