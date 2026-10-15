import { describe, expect, it } from "vitest";
import { decodeArchitecture } from "c4-sdk/core";
import { liftDefaultId } from "../src/catalog.ts";
import { chooseDefault } from "../src/routes.ts";
import { loadArchitectures } from "../src/sdk.ts";
import { readJson, readText } from "./fixtures.ts";

const SITE = "https://site.test/ts-db/";
const CATALOG_URL = `${SITE}catalog.json`;

/**
 * Serves the site from disk the way the deployed site is laid out: catalog.json is `catalog`, the fixture
 * bundle comes from tests/fixtures/ (it is never published), every other path from public/.
 */
function siteFetch(catalog: string): typeof fetch {
  return (input) => {
    const path = String(input).slice(SITE.length);
    const file = path === "architectures/fixture-third.json"
      ? "tests/fixtures/fixture-third.json"
      : `public/${path}`;
    const body = path === "catalog.json" ? catalog : readText(file);
    return Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
  };
}

async function load(catalog: string) {
  const lifted = liftDefaultId(CATALOG_URL, siteFetch(catalog));
  const entries = await loadArchitectures(CATALOG_URL, new AbortController().signal, lifted.fetch);
  const ids = entries.map(({ entry }) => entry.id);
  return {
    ids,
    ok: entries.map(({ result }) => result.ok),
    defaultId: lifted.defaultId(),
    choice: chooseDefault(ids, lifted.defaultId()),
  };
}

describe("catalog loading", () => {
  it("loads the site catalog and opens tsdb-current by default", async () => {
    expect(await load(readText("public/catalog.json"))).toEqual({
      ids: ["tsdb-current", "tsdb-lanes-proposal"],
      ok: [true, true],
      defaultId: "tsdb-current",
      choice: { ok: true, id: "tsdb-current" },
    });
  });

  it("loads a three-entry catalog with no code change, defaulting to its defaultId", async () => {
    // The fixture's defaultId is its LAST entry, so the default is not merely the first entry.
    expect(await load(readText("tests/fixtures/catalog-three.json"))).toEqual({
      ids: ["tsdb-current", "tsdb-lanes-proposal", "fixture-third"],
      ok: [true, true, true],
      defaultId: "fixture-third",
      choice: { ok: true, id: "fixture-third" },
    });
  });

  it("defaults to the first entry when the catalog has no defaultId", async () => {
    const { entries } = readJson("tests/fixtures/catalog-three.json") as { entries: unknown[] };
    const catalog = JSON.stringify({ entries: [entries[2], entries[0]] });
    expect(await load(catalog)).toEqual({
      ids: ["fixture-third", "tsdb-current"],
      ok: [true, true],
      defaultId: undefined,
      choice: { ok: true, id: "fixture-third" },
    });
  });

  it("lifts only defaultId: any other unknown catalog key is still rejected by the SDK", async () => {
    const catalog = JSON.stringify({ ...JSON.parse(readText("public/catalog.json")), extra: true });
    await expect(load(catalog)).rejects.toThrow(/"unrecognized_keys",\s*"keys": \[\s*"extra"/);
  });

  it("passes every other request through untouched", async () => {
    const response = new Response("{}");
    const lifted = liftDefaultId(CATALOG_URL, () => Promise.resolve(response));
    expect(await lifted.fetch(`${SITE}architectures/tsdb-current.json`)).toBe(response);
    expect(lifted.defaultId()).toBeUndefined();
  });
});

describe("the three-entry fixture bundle", () => {
  it("decodes with decodeArchitecture and no diagnostics at all", () => {
    const decoded = decodeArchitecture(readJson("tests/fixtures/fixture-third.json"));
    expect(decoded.diagnostics).toEqual([]);
    expect(decoded.ok).toBe(true);
  });
});
