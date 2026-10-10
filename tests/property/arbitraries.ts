// Property test arbitraries using fast-check
import fc from "npm:fast-check";
import type { Node, Field, Fields } from "../../core/schema.ts";

// Configure fast-check with a fixed seed for reproducibility
const SEED = 42;
fc.configureGlobal({ seed: SEED });

export const seed = SEED;

// Node generators
export const nodeKinds = fc.constantFrom(
  "string",
  "number",
  "integer",
  "boolean",
  "enum",
  "array",
) as fc.Arbitrary<"string" | "number" | "integer" | "boolean" | "enum" | "array">;

export const arb = {
  stringNode: (): fc.Arbitrary<Node> =>
    fc.record({
      kind: fc.constant("string" as const),
      nullable: fc.boolean().map((b) => (b ? true : undefined)),
    }),

  numberNode: (): fc.Arbitrary<Node> =>
    fc.record({
      kind: fc.constant("number" as const),
      nullable: fc.boolean().map((b) => (b ? true : undefined)),
    }),

  integerNode: (): fc.Arbitrary<Node> =>
    fc.record({
      kind: fc.constant("integer" as const),
      nullable: fc.boolean().map((b) => (b ? true : undefined)),
    }),

  booleanNode: (): fc.Arbitrary<Node> =>
    fc.record({
      kind: fc.constant("boolean" as const),
      nullable: fc.boolean().map((b) => (b ? true : undefined)),
    }),

  enumNode: (): fc.Arbitrary<Node> =>
    fc
      .array(fc.string({ minLength: 1, maxLength: 10 }), {
        minLength: 1,
        maxLength: 5,
      })
      .map((values) => ({
        kind: "enum" as const,
        values: values as readonly string[],
        nullable: fc.sample(fc.boolean(), 1)[0] ? true : undefined,
      })),

  arrayNode: (depth: number = 0): fc.Arbitrary<Node> => {
    if (depth >= 2) {
      return fc
        .oneof(
          arb.stringNode(),
          arb.numberNode(),
          arb.integerNode(),
          arb.booleanNode(),
        )
        .map((node) => ({
          kind: "array" as const,
          item: node,
          length: fc.sample(fc.integer({ min: 1, max: 10 }), 1)[0],
          nullable: fc.sample(fc.boolean(), 1)[0] ? true : undefined,
        }));
    }
    return fc
      .oneof(
        arb.stringNode(),
        arb.numberNode(),
        arb.integerNode(),
        arb.booleanNode(),
        arb.enumNode(),
        arb.arrayNode(depth + 1),
      )
      .map((node) => ({
        kind: "array" as const,
        item: node,
        length: fc.sample(fc.integer({ min: 1, max: 10 }), 1)[0],
        nullable: fc.sample(fc.boolean(), 1)[0] ? true : undefined,
      }));
  },

  node: (): fc.Arbitrary<Node> =>
    fc.oneof(
      arb.stringNode(),
      arb.numberNode(),
      arb.integerNode(),
      arb.booleanNode(),
      arb.enumNode(),
      arb.arrayNode(),
    ),

  // Generate a value that matches the given node
  matchingValue: (node: Node): fc.Arbitrary<unknown> => {
    if (node.nullable && fc.sample(fc.boolean(), 1)[0]) {
      return fc.constant(null);
    }

    switch (node.kind) {
      case "string":
        return fc.string();
      case "number":
        return fc.float({ noNaN: true });
      case "integer":
        return fc.integer();
      case "boolean":
        return fc.boolean();
      case "enum":
        return fc.constantFrom(...(node.values || []));
      case "array": {
        const itemGen = arb.matchingValue(node.item!);
        const len = node.length || 3;
        return fc.array(itemGen, { minLength: len, maxLength: len });
      }
    }
  },

  // Generate a value that does NOT match the given node
  nonMatchingValue: (node: Node): fc.Arbitrary<unknown> => {
    if (node.nullable) {
      // If node is nullable, we need to generate something that isn't null or the valid type
      switch (node.kind) {
        case "string":
          return fc.oneof(fc.integer(), fc.boolean());
        case "number":
          return fc.oneof(fc.string(), fc.boolean(), fc.constant(NaN), fc.constant(Infinity));
        case "integer":
          return fc.oneof(
            fc.float({ noNaN: true }).filter((n) => !Number.isSafeInteger(n)),
            fc.string(),
          );
        case "boolean":
          return fc.oneof(fc.string(), fc.integer());
        case "enum":
          return fc.string().filter((s) => !(node.values || []).includes(s));
        case "array":
          return fc.string();
        default:
          return fc.constant(undefined);
      }
    }

    switch (node.kind) {
      case "string":
        return fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
        );
      case "number":
        return fc.oneof(
          fc.string(),
          fc.boolean(),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
        );
      case "integer":
        return fc.oneof(
          fc.float({ noNaN: true }).filter((n) => !Number.isSafeInteger(n)),
          fc.string(),
          fc.boolean(),
        );
      case "boolean":
        return fc.oneof(fc.string(), fc.integer());
      case "enum":
        return fc.oneof(
          fc.string().filter((s) => !(node.values || []).includes(s)),
          fc.integer(),
        );
      case "array": {
        const wrongLen = (node.length || 3) + 1;
        return fc.oneof(
          fc.string(),
          fc.integer(),
          fc.array(fc.anything(), {
            minLength: wrongLen,
            maxLength: wrongLen,
          }),
        );
      }
    }
  },

  identifier: (valid: boolean = true): fc.Arbitrary<string> => {
    if (valid) {
      return fc
        .tuple(
          fc.constantFrom(
            ...[
              "abcdefghijklmnopqrstuvwxyz",
              "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
              "_",
            ],
          ),
          fc.string({
            minLength: 0,
            maxLength: 10,
          }),
        )
        .map(([first, rest]) => {
          const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
          const safeRest = rest.split("").filter((c) => chars.includes(c)).join("");
          return first + safeRest;
        });
    } else {
      return fc.oneof(
        fc.string({ minLength: 1, maxLength: 5 }).filter((s) => !/^[A-Za-z_]/.test(s)),
        fc
          .string({ minLength: 1, maxLength: 5 })
          .filter((s) => /[^\w]/.test(s)),
      );
    }
  },

  field: (): fc.Arbitrary<Field> =>
    arb.node().map((node) => ({ node })),

  fields: (): fc.Arbitrary<Fields> =>
    fc
      .dictionary(arb.identifier(true), arb.field(), {
        minKeys: 1,
        maxKeys: 5,
      })
      .filter((f) => Object.keys(f).length > 0),

  // For rotation tests
  fileEntry: () =>
    fc.record({
      path: fc.string({ minLength: 5, maxLength: 50 }),
      dir: fc.tuple(
        fc.integer({ min: 2020, max: 2026 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      ).map(([y, m, d]) => `logs/server/${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
      bytes: fc.integer({ min: 0, max: 1000000 }),
      mtime: fc.integer({ min: 0, max: 2000000000 }),
    }),

  // For rules tests
  mark: (): fc.Arbitrary<"X" | "O" | null> =>
    fc.oneof(fc.constant("X"), fc.constant("O"), fc.constant(null)),

  gameBoard: (): fc.Arbitrary<(string | null)[]> =>
    fc.array(arb.mark(), { minLength: 9, maxLength: 9 }),
};
