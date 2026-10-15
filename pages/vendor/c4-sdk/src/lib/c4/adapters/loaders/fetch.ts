import { z } from "zod";
import type { ArchitectureLoader, Catalog } from "../../ports/loader";
import { checkedDecodeLimits, decodeArchitecture, isSafeResourceUrl } from "../../schema/decode";
import type { DecodeLimits } from "../../schema/decode";
const MAX_BYTES = 5 * 1024 * 1024;
export async function readBoundedJson(response: Response, maxBytes = MAX_BYTES): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new Error(`maxBytes must be an integer from 1 to ${MAX_BYTES}.`);
  }
  if (!response.ok) throw new Error(`Resource request failed (HTTP ${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Resource exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) throw new Error("Resource has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Resource exceeds the ${maxBytes}-byte limit.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Resource is not valid UTF-8 JSON.");
  }
}
const catalogSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
      title: z.string().min(1).max(2000),
      url: z.string().refine(isSafeResourceUrl, "Use a safe relative or HTTPS resource URL."),
    }),
  ).min(1).max(200),
});
export interface FetchLoaderLimits {
  readonly maxBundleBytes?: number;
  readonly maxCatalogBytes?: number;
  readonly decode?: DecodeLimits;
}
export function createFetchLoader(
  fetchResource: typeof fetch = fetch,
  limits: FetchLoaderLimits = {},
): ArchitectureLoader {
  const maxBundleBytes = limits.maxBundleBytes ?? MAX_BYTES;
  const maxCatalogBytes = limits.maxCatalogBytes ?? 256 * 1024;
  for (
    const [key, value, maximum] of [["maxBundleBytes", maxBundleBytes, MAX_BYTES], [
      "maxCatalogBytes",
      maxCatalogBytes,
      256 * 1024,
    ]] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    }
  }
  const decode = checkedDecodeLimits(limits.decode);
  return {
    async loadCatalog(url, signal): Promise<Catalog> {
      const catalog = catalogSchema.parse(
        await readBoundedJson(await fetchResource(url, { signal }), maxCatalogBytes),
      );
      const ids = new Set(catalog.entries.map((entry) => entry.id));
      if (ids.size !== catalog.entries.length) throw new Error("Catalog entry IDs must be unique.");
      return {
        entries: catalog.entries.map((entry) => ({
          ...entry,
          url:
            new URL(entry.url, new URL(url, globalThis.location?.href ?? "https://consumer.invalid/")).href,
        })),
      };
    },
    async loadBundle(url, signal) {
      return decodeArchitecture(
        await readBoundedJson(await fetchResource(url, { signal }), maxBundleBytes),
        decode,
      );
    },
  };
}
