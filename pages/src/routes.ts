import { formatRoute, parseRoute } from "./sdk.ts";
import type { Diagram, ValidatedArchitecture } from "./sdk.ts";

/** Catalog entry ids, which equal the bundle ids (checked when the site loads). */
export const CURRENT_ID = "tsdb-current";
export const PROPOSED_ID = "tsdb-ffi-proposal";

/**
 * The site's URL grammar. Single views use the SDK's own deep links unchanged
 * (`#/architectures/<id>/diagrams/<id>[/elements/<id>][?step=<id>]`); the side-by-side view adds
 * `#/compare/<current diagram id>/<proposed diagram id>`. Anything else is Not Found, never a fallback.
 */
export type SiteRoute =
  | { readonly kind: "home" }
  | {
    readonly kind: "single";
    readonly architectureId: string;
    readonly diagramId: string;
  }
  | {
    readonly kind: "compare";
    readonly currentDiagramId: string;
    readonly proposedDiagramId: string;
  }
  | { readonly kind: "not-found"; readonly message: string };

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const comparePattern = /^#\/compare\/([^/?#]+)\/([^/?#]+)$/;

export function parseSiteRoute(hash: string): SiteRoute {
  if (hash === "" || hash === "#") return { kind: "home" };
  if (hash.startsWith("#/compare")) {
    const match = comparePattern.exec(hash);
    let ids: string[] = [];
    try {
      ids = match ? match.slice(1).map((part) => decodeURIComponent(part)) : [];
    } catch {
      ids = [];
    }
    if (ids.length !== 2 || !ids.every((id) => idPattern.test(id))) {
      return {
        kind: "not-found",
        message: "A side-by-side link names a current diagram id and a proposed diagram id.",
      };
    }
    return {
      kind: "compare",
      currentDiagramId: ids[0],
      proposedDiagramId: ids[1],
    };
  }
  const parsed = parseRoute(hash);
  if (!parsed.ok) {
    return {
      kind: "not-found",
      message: parsed.diagnostics.map((d) => d.message).join(" "),
    };
  }
  if (!parsed.value) return { kind: "home" };
  return {
    kind: "single",
    architectureId: parsed.value.architectureId,
    diagramId: parsed.value.diagramId,
  };
}

export function compareHash(
  currentDiagramId: string,
  proposedDiagramId: string,
): string {
  return `#/compare/${encodeURIComponent(currentDiagramId)}/${encodeURIComponent(proposedDiagramId)}`;
}

export function singleHash(architectureId: string, diagramId: string): string {
  return formatRoute({ architectureId, diagramId });
}

/**
 * The diagram of `target` that best matches the C4 level the reader is looking at: the first diagram of
 * the same kind (bundle order is the authored reading order), else the bundle's default diagram.
 */
export function counterpart(
  target: ValidatedArchitecture,
  kind: Diagram["kind"] | undefined,
): string {
  const bundle = target.bundle;
  return bundle.diagrams.find((diagram) => diagram.kind === kind)?.id ??
    bundle.defaultDiagramId;
}

/** C4 levels drawn in both datasets, each with the first diagram of that level on either side. */
export function sharedLevels(
  current: ValidatedArchitecture,
  proposed: ValidatedArchitecture,
): readonly {
  readonly kind: Diagram["kind"];
  readonly currentId: string;
  readonly proposedId: string;
}[] {
  const levels: {
    kind: Diagram["kind"];
    currentId: string;
    proposedId: string;
  }[] = [];
  for (const diagram of current.bundle.diagrams) {
    if (levels.some((level) => level.kind === diagram.kind)) continue;
    const other = proposed.bundle.diagrams.find((candidate) => candidate.kind === diagram.kind);
    if (other) {
      levels.push({
        kind: diagram.kind,
        currentId: diagram.id,
        proposedId: other.id,
      });
    }
  }
  return levels;
}

export const levelNames: Readonly<Record<Diagram["kind"], string>> = {
  landscape: "Landscape",
  context: "System context",
  container: "Containers",
  component: "Components",
  code: "Code",
  dynamic: "Dynamic",
  deployment: "Deployment",
};
