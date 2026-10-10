import { DuckReader } from "./duckdb.ts";
import { loadApps, trace } from "./registry.ts";
import { lines } from "./ipc.ts";
import type { Schema } from "../sdk/schema.ts";
const apps = loadApps();
const readers = new Map<string, DuckReader<Schema>>();
const output = Deno.stdout.writable.getWriter();
try {
  // One query handler at a time. A pool is deliberately not part of this MVP.
  for await (const line of lines(Deno.stdin.readable)) {
    const request = JSON.parse(line);
    let reply: unknown;
    try {
      if (request.kind === "ping") reply = { id: request.id, result: "ready" };
      else {
        const app = apps.get(request.appId);
        if (!app || !Object.hasOwn(app.functions, request.name)) throw new Error("Unknown app or handler");
        const definition = app.functions[request.name as keyof typeof app.functions];
        if (definition.kind !== "query") throw new Error("Reader accepts queries only");
        let reader = readers.get(app.id);
        if (!reader) {
          reader = await DuckReader.open(app.file, app.schema, trace);
          readers.set(app.id, reader);
        }
        reply = { id: request.id, result: await reader.query(definition, request.args) };
      }
    } catch (e) { reply = { id: request.id, error: e instanceof Error ? e.message : String(e) }; }
    await output.write(new TextEncoder().encode(JSON.stringify(reply) + "\n"));
  }
} finally {
  for (const reader of readers.values()) reader.close();
  output.releaseLock();
}
