import { findStep } from "./scenario";
import type { Diagnostic, ModelIndex, Result, Target } from "./model";
export interface Route extends Target {
  readonly architectureId: string;
  readonly stepId?: string;
}
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const failure = <T>(message: string, path = "$.route"): Result<T> => ({
  ok: false,
  diagnostics: [{ code: "route", severity: "error", path, message }],
});
export function formatRoute(route: Route): string {
  return `#/architectures/${encodeURIComponent(route.architectureId)}/diagrams/${
    encodeURIComponent(route.diagramId)
  }${route.elementId ? `/elements/${encodeURIComponent(route.elementId)}` : ""}${
    route.stepId ? `?step=${encodeURIComponent(route.stepId)}` : ""
  }`;
}
export function parseRoute(hash: string): Result<Route | undefined> {
  if (!hash || hash === "#") return { ok: true, value: undefined, diagnostics: [] };
  const match =
    /^#\/architectures\/([^/?]+)\/diagrams\/([^/?]+)(?:\/elements\/([^/?]+))?(?:\?step=([^/?&=]+))?$/.exec(
      hash,
    );
  if (!match) return failure("Not Found: use an architecture/diagram URL, optionally with an element.");
  try {
    const parts = match.slice(1).map((part) => part === undefined ? undefined : decodeURIComponent(part));
    if (!parts.every((part) => part === undefined || id.test(part))) {
      return failure("Route IDs do not match the architecture ID grammar.");
    }
    return {
      ok: true,
      value: {
        architectureId: parts[0]!,
        diagramId: parts[1]!,
        ...(parts[2] ? { elementId: parts[2] } : {}),
        ...(parts[3] ? { stepId: parts[3] } : {}),
      },
      diagnostics: [],
    };
  } catch {
    return failure("Malformed percent encoding in route.");
  }
}
export function validateRoute(index: ModelIndex, route: Route): readonly Diagnostic[] {
  if (route.architectureId !== index.bundle.id) {
    return failure("This route belongs to another architecture.", "$.route.architectureId").diagnostics;
  }
  const diagram = index.diagrams[route.diagramId];
  if (!diagram) {
    return failure(`Not Found: unknown diagram "${route.diagramId}".`, "$.route.diagramId").diagnostics;
  }
  if (route.elementId && !diagram.nodes.some((node) => node.elementId === route.elementId)) {
    return failure(`Element "${route.elementId}" is not in this diagram.`, "$.route.elementId").diagnostics;
  }
  if (route.stepId && (diagram.kind !== "dynamic" || !findStep(diagram.scenario, route.stepId))) {
    return failure(`Unknown scenario step "${route.stepId}" for this diagram.`, "$.route.stepId").diagnostics;
  }
  return [];
}
export function breadcrumbs(index: ModelIndex, route: Route): readonly Target[] {
  const trail: Target[] = [];
  const seen = new Set<string>();
  let current: Target | undefined = { diagramId: route.diagramId };
  while (current && !seen.has(current.diagramId) && index.diagrams[current.diagramId]) {
    seen.add(current.diagramId);
    trail.unshift(current);
    current = index.diagrams[current.diagramId].parent;
  }
  return trail;
}
export type NavigationAction =
  | { readonly type: "step"; readonly stepId?: string }
  | { readonly type: "activate" | "inspect"; readonly elementId: string }
  | { readonly type: "diagram" | "up" | "back" }
  | { readonly type: "target"; readonly target: Target };
export type NavigationEffect = { readonly type: "push"; readonly route: Route } | { readonly type: "back" };
/** Pure decisions only: browser history owns Back; no duplicate navigation stack. */
export function transition(
  index: ModelIndex,
  route: Route,
  action: NavigationAction,
  canGoBack = false,
): Result<NavigationEffect> {
  if (action.type === "back" && canGoBack) return { ok: true, value: { type: "back" }, diagnostics: [] };
  const diagram = index.diagrams[route.diagramId];
  let target: Target | undefined;
  if (action.type === "step") {
    target = { diagramId: route.diagramId, ...(route.elementId ? { elementId: route.elementId } : {}) };
  } else if (action.type === "activate" || action.type === "inspect") {
    const member = diagram?.nodes.find((node) => node.elementId === action.elementId);
    if (!member) return failure("Cannot select an element outside this diagram.", "$.route.elementId");
    target = action.type === "activate" && member.detail
      ? member.detail
      : { diagramId: route.diagramId, elementId: action.elementId };
  } else if (action.type === "target") target = action.target;
  else if (action.type === "diagram") target = { diagramId: route.diagramId };
  else target = diagram?.parent ?? { diagramId: index.bundle.defaultDiagramId };
  const preservedStep = action.type === "step"
    ? action.stepId
    : (action.type === "inspect" || action.type === "diagram" ||
        action.type === "activate" &&
          !diagram?.nodes.find((member) => member.elementId === action.elementId)?.detail) &&
        target?.diagramId === route.diagramId
    ? route.stepId
    : undefined;
  const next: Route = {
    architectureId: index.bundle.id,
    ...target,
    ...(preservedStep ? { stepId: preservedStep } : {}),
  };
  const diagnostics = validateRoute(index, next);
  return diagnostics.length
    ? { ok: false, diagnostics }
    : { ok: true, value: { type: "push", route: next }, diagnostics: [] };
}

export function relatedTargets(index: ModelIndex, route: Route): readonly import("./model").Link[] {
  if (route.architectureId !== index.bundle.id) return [];
  const diagram = index.diagrams[route.diagramId];
  return [
    ...(diagram?.related ?? []),
    ...(diagram?.nodes.find((node) => node.elementId === route.elementId)?.related ?? []),
  ];
}
export function detailTarget(index: ModelIndex, route: Route, elementId: string): Target | undefined {
  return route.architectureId === index.bundle.id
    ? index.diagrams[route.diagramId]?.nodes.find((member) => member.elementId === elementId)?.detail
    : undefined;
}
export function recoveryTarget(index: ModelIndex, route: Route): Target {
  return { diagramId: index.diagrams[route.diagramId]?.id ?? index.bundle.defaultDiagramId };
}
export function catalogRouteDiagnostics(
  catalog: { readonly entries: readonly { readonly id: string }[] } | undefined,
  architectureId?: string,
): readonly Diagnostic[] {
  return architectureId && catalog && !catalog.entries.some((entry) => entry.id === architectureId)
    ? failure(`Not Found: unknown architecture "${architectureId}".`, "$.route.architectureId").diagnostics
    : [];
}
export interface LinkGesture {
  readonly button: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
}
/** Native navigation owns modified clicks and alternate mouse buttons. */
export function isOrdinaryLinkActivation(event: LinkGesture): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
    !event.defaultPrevented;
}
