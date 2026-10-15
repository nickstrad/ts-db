/**
 * `catalog.json` is the SDK catalog (`{ entries: [{ id, title, url }] }`) plus one site-level key,
 * `defaultId`: the entry the site opens when the URL names none. The SDK's catalog schema is strict, so the
 * site hands the SDK loader this fetch, which lifts `defaultId` off the catalog response before the SDK
 * reads it. Every other request, and any catalog the SDK would reject anyway, passes through unchanged so
 * the SDK reports it.
 */

/** The SDK fetch loader's catalog size limit. */
const MAX_CATALOG_BYTES = 256 * 1024;

export interface CatalogFetch {
  /** The fetch to give the SDK loader. */
  readonly fetch: typeof fetch;
  /** The `defaultId` value read from the catalog (`undefined` until it is loaded, or if it has none). */
  readonly defaultId: () => unknown;
}

export function liftDefaultId(
  catalogUrl: string,
  fetchResource: typeof fetch = fetch,
): CatalogFetch {
  let defaultId: unknown;
  return {
    defaultId: () => defaultId,
    fetch: async (input, init) => {
      const response = await fetchResource(input, init);
      if (input !== catalogUrl || !response.ok) return response;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) return response;
      const bytes = await response.arrayBuffer();
      const status = { status: response.status, statusText: response.statusText };
      const unchanged = () => new Response(bytes, status);
      if (bytes.byteLength > MAX_CATALOG_BYTES) return unchanged();
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return unchanged();
      }
      if (typeof json !== "object" || json === null || Array.isArray(json) || !("defaultId" in json)) {
        return unchanged();
      }
      const { defaultId: lifted, ...catalog } = json as Record<string, unknown>;
      defaultId = lifted;
      return new Response(JSON.stringify(catalog), status);
    },
  };
}
