import { describe, expect, it } from "vitest";
import { decodeArchitecture } from "c4-sdk/core";
import type { ValidatedArchitecture } from "c4-sdk/core";
import { compareHash, counterpart, parseSiteRoute, sharedLevels } from "../src/routes.ts";
import { createMemoryRoutePort } from "../src/sdk.ts";
import { bundles } from "./fixtures.ts";

describe("parseSiteRoute", () => {
  it.each([
    ["", { kind: "home" }],
    ["#", { kind: "home" }],
    ["#/architectures/tsdb-current/diagrams/context", {
      kind: "single",
      architectureId: "tsdb-current",
      diagramId: "context",
    }],
    [
      "#/architectures/tsdb-current/diagrams/components-server/elements/storage",
      {
        kind: "single",
        architectureId: "tsdb-current",
        diagramId: "components-server",
      },
    ],
    ["#/compare/context/ffi-context", {
      kind: "compare",
      currentDiagramId: "context",
      proposedDiagramId: "ffi-context",
    }],
  ])("%j", (hash, expected) => {
    expect(parseSiteRoute(hash)).toEqual(expected);
  });

  // Never a silent fallback: each of these is Not Found.
  it.each([
    "#/compare/context",
    "#/compare/a%2Fb/ffi-context",
    "#/compare/context/ffi-context/x",
    "#/somewhere",
  ])(
    "%j is Not Found",
    (hash) => {
      expect(parseSiteRoute(hash).kind).toBe("not-found");
    },
  );

  it("formats compare links that parse back", () => {
    expect(compareHash("containers-platform", "ffi-containers")).toBe(
      "#/compare/containers-platform/ffi-containers",
    );
  });
});

describe("createMemoryRoutePort", () => {
  const route = (diagramId: string) => ({
    architectureId: "tsdb-current",
    diagramId,
  });

  it("keeps a history stack without touching the URL", () => {
    const port = createMemoryRoutePort(route("context"));
    let notified = 0;
    const unsubscribe = port.subscribe(() => notified++);
    expect(port.getSnapshot()).toEqual({
      hash: "#/architectures/tsdb-current/diagrams/context",
      canGoBack: false,
    });

    port.push(route("containers-platform"));
    expect(port.getSnapshot()).toEqual({
      hash: "#/architectures/tsdb-current/diagrams/containers-platform",
      canGoBack: true,
    });
    expect(notified).toBe(1);

    // Writing the route already shown is a no-op, and the snapshot object stays the same.
    const before = port.getSnapshot();
    port.push(route("containers-platform"));
    expect(port.getSnapshot()).toBe(before);
    expect(notified).toBe(1);

    port.replace(route("components-server"));
    expect(port.route()).toEqual(route("components-server"));
    expect(port.getSnapshot().canGoBack).toBe(true);
    expect(notified).toBe(2);

    port.back();
    expect(port.route()).toEqual(route("context"));
    expect(port.getSnapshot().canGoBack).toBe(false);
    port.back();
    expect(notified).toBe(3);

    unsubscribe();
    port.push(route("containers-observability"));
    expect(notified).toBe(3);
  });
});

describe("levels shared by both datasets", () => {
  const [current, proposed] = bundles.map(({ json }) => {
    const decoded = decodeArchitecture(json);
    if (!decoded.ok) throw new Error("bundle does not decode");
    return decoded.value as ValidatedArchitecture;
  });

  it("pairs the first diagram of each C4 level drawn on both sides", () => {
    expect(sharedLevels(current, proposed)).toEqual([
      { kind: "context", currentId: "context", proposedId: "ffi-context" },
      {
        kind: "container",
        currentId: "containers-platform",
        proposedId: "ffi-containers",
      },
    ]);
  });

  it("falls back to the default diagram when a level is not drawn", () => {
    expect(counterpart(proposed, "component")).toBe("ffi-context");
    expect(counterpart(current, "container")).toBe("containers-platform");
  });
});
