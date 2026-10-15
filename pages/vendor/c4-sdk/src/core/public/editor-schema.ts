import { architectureJsonSchema as editorSchema } from "../../lib/c4/schema/decode";

/** Editor shape only. Runtime decoding remains the validation boundary. */
export const architectureJsonSchema: Readonly<Record<string, unknown>> = editorSchema;
