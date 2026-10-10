import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteWriter } from "./sqlite.ts";
import { ReaderRPC } from "./ipc.ts";
import { loadApps, trace } from "./registry.ts";
import { objectStore } from "./object_store.ts";
import { Backups } from "./backup.ts";

const apps = loadApps();
const writers = new Map<string, SQLiteWriter<typeof import("../app/schema.ts").schema>>();
for (const app of apps.values()) {
  await Deno.mkdir(dirname(app.file), { recursive: true });
  writers.set(app.id, new SQLiteWriter(app.file, app.schema, trace));
}
// Second OS process: isolates the two SQLite native-library copies.
const reader = new ReaderRPC(fileURLToPath(new URL("./reader.ts", import.meta.url)));
await reader.call({ kind: "ping" });
const backups = new Backups(await objectStore());
const adminToken = Deno.env.get("ADMIN_TOKEN") ?? "dev-only";
const reply = (body: unknown, status = 200) => Response.json(body, { status });
async function parseArgs(req: Request): Promise<unknown> {
  if (!req.body) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of req.body) {
    size += chunk.length;
    if (size > 65_536) throw new Error("Request exceeds 64 KiB");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes) || "{}");
}
const server = Deno.serve(
  { hostname: "127.0.0.1", port: Number(Deno.env.get("PORT") ?? 8000) },
  async (req) => {
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        await reader.call({ kind: "ping" });
        return reply({ ok: true, apps: [...apps.keys()] });
      }
      if (req.method !== "POST") return reply({ error: "Not found" }, 404);
      const backupMatch = path.match(/^\/admin\/backup\/([^/]+)$/);
      if (backupMatch) {
        if (req.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return reply({
            error: "Unauthorized",
          }, 401);
        }
        const app = apps.get(backupMatch[1]);
        if (!app) return reply({ error: "Unknown app" }, 404);
        return reply({ result: await backups.take(app.id, writers.get(app.id)!) });
      }
      const match = path.match(/^\/apps\/([^/]+)\/(query|mutation)\/([A-Za-z][A-Za-z0-9_]*)$/);
      if (!match) return reply({ error: "Not found" }, 404);
      const [, appId, kind, name] = match;
      const app = apps.get(appId);
      if (!app) return reply({ error: "Unknown app" }, 404);
      if (req.headers.get("authorization") !== `Bearer ${app.token}`) {
        return reply(
          { error: "Unauthorized" },
          401,
        );
      }
      if (!Object.hasOwn(app.functions, name)) return reply({ error: "Unknown handler" }, 404);
      const definition = app.functions[name as keyof typeof app.functions];
      if (definition.kind !== kind) return reply({ error: "Handler kind mismatch" }, 400);
      const args = await parseArgs(req);
      const result = kind === "mutation"
        ? await writers.get(appId)!.mutation(definition, args)
        : await reader.call({ kind: "query", appId, name, args });
      return reply({ result });
    } catch (e) {
      // Detailed errors are useful locally, but need classification/redaction for production.
      return reply({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  },
);

// Opt in. A completed mutation acknowledges LOCAL commit, not object-storage upload.
const interval = Number(Deno.env.get("BACKUP_INTERVAL_MS") ?? 0);
if (!Number.isFinite(interval) || (interval !== 0 && interval < 1000)) {
  throw new Error("Invalid backup interval");
}
let backupTick: Promise<void> | undefined;
const timer = interval
  ? setInterval(() => {
    if (backupTick) return;
    backupTick = (async () => {
      for (const [id, writer] of writers) {
        try {
          console.error(JSON.stringify({ backup: await backups.take(id, writer) }));
        } catch (e) {
          console.error("Backup failed:", id, e);
        }
      }
    })().finally(() => {
      backupTick = undefined;
    });
  }, interval)
  : undefined;

console.error("Local/trusted-app MVP. Default token: dev-only. Reader + writer share local files.");
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (timer !== undefined) clearInterval(timer);
  await server.shutdown();
  await backupTick;
  await reader.close();
  for (const writer of writers.values()) await writer.close();
  Deno.removeSignalListener("SIGINT", onSignal);
  Deno.removeSignalListener("SIGTERM", onSignal);
}
const onSignal = () => {
  void shutdown();
};
Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);
await server.finished;
