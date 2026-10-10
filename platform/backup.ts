import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLiteWriter } from "./sqlite.ts";
import type { Schema } from "../sdk/schema.ts";
import { sha256, type ObjectStore } from "./object_store.ts";
export type Manifest = { format: 1; appId: string; capturedAt: string; key: string; bytes: number; sha256: string };

export function integrityCheck(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const results = db.prepare("PRAGMA quick_check").all();
    if (results.length !== 1 || results[0].quick_check !== "ok") throw new Error("Snapshot failed integrity check");
  } finally { db.close(); }
}
export class Backups {
  private active = new Set<string>();
  constructor(private store: ObjectStore) {}
  async take(appId: string, writer: SQLiteWriter<Schema>): Promise<Manifest> {
    if (this.active.has(appId)) throw new Error("Backup already running for this app");
    this.active.add(appId);
    let directory: string | undefined;
    try {
      directory = await Deno.makeTempDir({ prefix: "document-db-backup-" });
      const snapshot = resolve(directory, "snapshot.sqlite");
      await writer.snapshot(snapshot); // Serializes only snapshot creation with mutations.
      const capturedAt = new Date().toISOString();
      integrityCheck(snapshot);
      const bytes = await Deno.readFile(snapshot);
      const key = `apps/${appId}/${capturedAt.replaceAll(":", "-")}-${crypto.randomUUID()}.sqlite`;
      const manifest: Manifest = { format: 1, appId, capturedAt, key, bytes: bytes.length, sha256: await sha256(bytes) };
      const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      // Upload immutable data first; publish latest only after successful uploads.
      await this.store.put(key, bytes);
      await this.store.put(`${key}.json`, json);
      await this.store.put(`apps/${appId}/latest.json`, json);
      return manifest;
    } finally {
      this.active.delete(appId);
      if (directory) await Deno.remove(directory, { recursive: true });
    }
  }
}
