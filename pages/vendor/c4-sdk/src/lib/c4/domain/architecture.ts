import { validateDeployment } from "./deployment";
import { validateCode } from "./codeview";
import { validateScenario } from "./scenario";
import { validateGroups } from "./groups";
import type { ArchitectureBundle, Diagnostic, Diagram, Element, ModelIndex, References } from "./model";

function keyed<T extends { readonly id: string }>(items: readonly T[]): Readonly<Record<string, T>> {
  return Object.freeze(
    Object.assign(Object.create(null), Object.fromEntries(items.map((item) => [item.id, item]))),
  );
}
export function buildIndex(bundle: ArchitectureBundle): ModelIndex {
  return Object.freeze({
    bundle,
    elements: keyed(bundle.model.elements),
    relationships: keyed(bundle.model.relationships),
    diagrams: keyed(bundle.diagrams),
    documents: keyed(bundle.documents),
    sources: keyed(bundle.sources),
    terms: keyed(bundle.terms),
  });
}

/** Checks references without constructing a usable index from invalid input. */
export function validateArchitecture(bundle: ArchitectureBundle): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) =>
    diagnostics.push({ code, path, message, severity: "error" });
  const warning = (code: string, path: string, message: string) =>
    diagnostics.push({ code, path, message, severity: "warning" });
  const collections = {
    elements: bundle.model.elements,
    relationships: bundle.model.relationships,
    diagrams: bundle.diagrams,
    documents: bundle.documents,
    sources: bundle.sources,
    terms: bundle.terms,
  };
  const ids = (items: readonly { readonly id: string }[], path: string) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) error("duplicate-id", `${path}[${i}].id`, `Duplicate ID "${item.id}".`);
      seen.add(item.id);
    });
    return seen;
  };
  const sets = {
    elements: ids(collections.elements, "$.model.elements"),
    relationships: ids(collections.relationships, "$.model.relationships"),
    diagrams: ids(collections.diagrams, "$.diagrams"),
    documents: ids(collections.documents, "$.documents"),
    sources: ids(collections.sources, "$.sources"),
    terms: ids(collections.terms, "$.terms"),
  };
  const reference = (set: Set<string>, id: string, path: string) => {
    if (!set.has(id)) error("missing-reference", path, `Unknown reference "${id}".`);
  };
  const refs = (item: References, path: string) => {
    item.docIds.forEach((id, i) => reference(sets.documents, id, `${path}.docIds[${i}]`));
    item.sourceIds.forEach((id, i) => reference(sets.sources, id, `${path}.sourceIds[${i}]`));
  };
  reference(sets.diagrams, bundle.defaultDiagramId, "$.defaultDiagramId");
  bundle.model.elements.forEach((item, i) => {
    const path = `$.model.elements[${i}]`;
    refs(item, path);
    if (item.kind === "container" || item.kind === "component") {
      reference(sets.elements, item.parentId, `${path}.parentId`);
      const requiredParent = item.kind === "component" ? "container" : "softwareSystem";
      if (bundle.model.elements.find((element) => element.id === item.parentId)?.kind !== requiredParent) {
        error("invalid-parent", `${path}.parentId`, `A ${item.kind} belongs to a ${requiredParent}.`);
      }
    }
    if (item.status === "mixed" && item.plannedNotes.length === 0) {
      error("mixed-notes", `${path}.plannedNotes`, "Mixed status requires planned notes.");
    }
  });
  bundle.model.relationships.forEach((item, i) => {
    const path = `$.model.relationships[${i}]`;
    refs(item, path);
    reference(sets.elements, item.sourceId, `${path}.sourceId`);
    reference(sets.elements, item.targetId, `${path}.targetId`);
    if (item.status === "mixed" && item.plannedNotes.length === 0) {
      error("mixed-notes", `${path}.plannedNotes`, "Mixed status requires planned notes.");
    }
  });
  bundle.documents.forEach((item, i) => {
    const path = `$.documents[${i}]`;
    item.sourceIds.forEach((id, j) => reference(sets.sources, id, `${path}.sourceIds[${j}]`));
    item.termIds.forEach((id, j) => reference(sets.terms, id, `${path}.termIds[${j}]`));
    if (item.ste.reviewStatus === "reviewed" && (!item.ste.reviewer?.trim() || !item.ste.reviewedAt)) {
      error("review-metadata", `${path}.ste`, "Reviewed text requires a reviewer and date.");
    }
  });
  bundle.diagrams.forEach((diagram, i) => {
    const path = `$.diagrams[${i}]`;
    refs(diagram, path);
    if (diagram.scopeId) reference(sets.elements, diagram.scopeId, `${path}.scopeId`);
    const scope = bundle.model.elements.find((item) => item.id === diagram.scopeId);
    const scopeKinds = {
      landscape: "softwareSystem",
      context: "softwareSystem",
      container: "softwareSystem",
      component: "container",
      code: "component",
    } as const;
    if (
      diagram.kind !== "dynamic" && diagram.kind !== "deployment" && scope &&
      scope.kind !== scopeKinds[diagram.kind]
    ) {
      error(
        "invalid-scope",
        `${path}.scopeId`,
        `A ${diagram.kind} scope must be a ${scopeKinds[diagram.kind]}.`,
      );
    }
    const members = new Set<string>();
    const edges = new Set<string>();
    diagram.nodes.forEach((node, j) => {
      reference(sets.elements, node.elementId, `${path}.nodes[${j}].elementId`);
      if (members.has(node.elementId)) {
        error("duplicate-member", `${path}.nodes[${j}].elementId`, "Element occurs twice in this view.");
      }
      members.add(node.elementId);
      const element = bundle.model.elements.find((item) => item.id === node.elementId);
      if (
        (diagram.kind === "context" || diagram.kind === "landscape") && element &&
        element.kind !== "person" && element.kind !== "softwareSystem" && element.kind !== "deploymentNode" &&
        element.kind !== "infrastructureNode" && element.kind !== "instance"
      ) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          `${
            diagram.kind === "landscape" ? "Landscape" : "Context"
          } members must be persons or software systems.`,
        );
      }
      if (
        diagram.kind === "code" && element && element.kind !== "code" && element.kind !== "deploymentNode" &&
        element.kind !== "infrastructureNode" && element.kind !== "instance"
      ) error("invalid-member", `${path}.nodes[${j}].elementId`, "Code views contain only code elements.");
      if (
        (diagram.kind === "container" || diagram.kind === "component" || diagram.kind === "dynamic") &&
        element?.kind === "code"
      ) error("invalid-member", `${path}.nodes[${j}].elementId`, "Code elements appear only in code views.");
      if (
        diagram.kind === "container" && element?.kind === "container" &&
        element.parentId !== diagram.scopeId && !element.tags.includes("external")
      ) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Supporting containers outside the scope must be tagged external.",
        );
      }
      if (diagram.kind === "container" && element?.kind === "component") {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Container views cannot include components.",
        );
      }
      if (
        diagram.kind === "component" && element?.kind === "component" &&
        element.parentId !== diagram.scopeId && !element.tags.includes("external")
      ) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Supporting components outside the scope must be tagged external.",
        );
      }
      if (
        diagram.kind === "component" && element && element.kind !== "component" &&
        element.kind !== "person" && !element.tags.includes("external")
      ) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Supporting systems and containers must be tagged external in a component view.",
        );
      }
      if (diagram.kind === "component" && element?.id === diagram.scopeId) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Component view shows contents of its scope, not the scoped container.",
        );
      }
      if (diagram.kind === "container" && element?.id === diagram.scopeId) {
        error(
          "invalid-member",
          `${path}.nodes[${j}].elementId`,
          "Container view shows contents of its scope, not the scoped system.",
        );
      }
      if (diagram.layout?.mode === "manual" && !node.position) {
        error("missing-position", `${path}.nodes[${j}].position`, "Manual layout requires every position.");
      }
      if (diagram.layout?.mode !== "manual" && node.position) {
        error(
          "partial-layout",
          `${path}.nodes[${j}].position`,
          "Auto layout does not accept fixed positions. Use manual mode.",
        );
      }
    });
    if (diagram.kind === "landscape" && diagram.scopeId && !members.has(diagram.scopeId)) {
      error("scope-not-visible", `${path}.scopeId`, "The scoped system must appear in the view.");
    }
    if (diagram.kind === "context" && !members.has(diagram.scopeId)) {
      error("scope-not-visible", `${path}.scopeId`, "The scoped system must appear in the view.");
    }
    diagram.edges.forEach((edge, j) => {
      const edgePath = `${path}.edges[${j}].relationshipId`;
      reference(sets.relationships, edge.relationshipId, edgePath);
      if (edges.has(edge.relationshipId)) {
        error("duplicate-edge", edgePath, "Relationship occurs twice in this view.");
      }
      edges.add(edge.relationshipId);
      const relationship = bundle.model.relationships.find((item) => item.id === edge.relationshipId);
      if (relationship) {
        if (!members.has(relationship.sourceId) || !members.has(relationship.targetId)) {
          error("endpoint-not-visible", edgePath, "Both relationship endpoints must appear in the view.");
        }
        if (!relationship.technology) {
          warning(
            "missing-protocol",
            edgePath,
            `Relationship "${relationship.label}" has no protocol or technology.`,
          );
        }
      }
    });
    if (diagram.kind === "dynamic") diagnostics.push(...validateScenario(diagram, buildIndex(bundle), path));
    diagnostics.push(
      ...validateGroups(diagram.groups ?? [], diagram.nodes.map((node) => node.elementId), `${path}.groups`),
    );
    ids(diagram.legend.entries, `${path}.legend.entries`);
    const required = new Set<string>(diagram.kind === "context" ? ["accent"] : []);
    if (diagram.groups?.length) required.add("boundary");
    if (diagram.groups?.some((group) => group.status !== "existing")) required.add("dashed");
    diagram.nodes.forEach((node) => {
      const element = bundle.model.elements.find((item) => item.id === node.elementId);
      if (element) {
        required.add(
          element.kind === "person" ? "person" : element.tags.includes("external") ? "external" : "box",
        );
      }
      if (element?.status !== "existing") required.add("dashed");
    });
    if (diagram.edges.length) required.add("forward");
    if (
      diagram.edges.some((edge) =>
        bundle.model.relationships.find((item) => item.id === edge.relationshipId)?.status !== "existing"
      )
    ) required.add("dashed");
    const swatches = diagram.legend.entries.map((entry) => entry.swatch);
    required.forEach((notation) => {
      if (
        !swatches.some((s) =>
          s.shape === notation || s.tone === notation || s.stroke === notation || s.arrow === notation
        )
      ) warning("legend-coverage", `${path}.legend.entries`, `Key does not explain "${notation}" notation.`);
    });
    if (diagram.nodes.length > 200 || diagram.edges.length > 400) {
      warning("large-view", path, "This view exceeds the initial 200-node / 400-edge rendering target.");
    }
  });
  const checkTarget = (target: import("./model").Target, path: string) => {
    reference(sets.diagrams, target.diagramId, `${path}.diagramId`);
    const destination = bundle.diagrams.find((item) => item.id === target.diagramId);
    if (
      target.elementId && destination &&
      !destination.nodes.some((node) => node.elementId === target.elementId)
    ) {
      error(
        "target-not-visible",
        `${path}.elementId`,
        "Target element must be visible in the destination diagram.",
      );
    }
  };
  bundle.diagrams.forEach((diagram, i) => {
    const path = `$.diagrams[${i}]`;
    if (diagram.parent) checkTarget(diagram.parent, `${path}.parent`);
    diagram.related.forEach((target, j) => checkTarget(target, `${path}.related[${j}]`));
    diagram.nodes.forEach((member, j) => {
      const memberPath = `${path}.nodes[${j}]`;
      member.related.forEach((target, k) => checkTarget(target, `${memberPath}.related[${k}]`));
      if (member.detail) {
        checkTarget(member.detail, `${memberPath}.detail`);
        const destination = bundle.diagrams.find((item) => item.id === member.detail?.diagramId);
        const element = bundle.model.elements.find((item) => item.id === member.elementId);
        if (destination && !validDetail(diagram, element, destination)) {
          error(
            "invalid-detail",
            `${memberPath}.detail`,
            "Detail must identify the corresponding next scope (landscape system to its context, system context to containers, container to components, or component to code).",
          );
        }
      }
    });
    const visited = new Set<string>();
    let current: typeof diagram | undefined = diagram;
    while (current) {
      if (visited.has(current.id)) {
        error("parent-cycle", `${path}.parent`, "Canonical diagram parents must form a terminating forest.");
        break;
      }
      visited.add(current.id);
      current = current.parent
        ? bundle.diagrams.find((item) => item.id === current?.parent?.diagramId)
        : undefined;
    }
  });
  const fullIndex = buildIndex(bundle);
  diagnostics.push(...validateDeployment(bundle, fullIndex), ...validateCode(bundle, fullIndex));
  return diagnostics;
}

/** The destination of a member's native detail link must be the next scope of that member. */
function validDetail(diagram: Diagram, element: Element | undefined, destination: Diagram): boolean {
  if (!element) return false;
  const scopedTo = "scopeId" in destination && destination.scopeId === element.id;
  if (diagram.kind === "landscape") {
    return element.kind === "softwareSystem" && destination.kind === "context" && scopedTo;
  }
  if (diagram.kind === "context") {
    return element.kind === "softwareSystem" && destination.kind === "container" && scopedTo;
  }
  if (diagram.kind === "container") {
    return element.kind === "container" && destination.kind === "component" && scopedTo;
  }
  if (diagram.kind === "component") {
    return element.kind === "component" && destination.kind === "code" && scopedTo;
  }
  if (diagram.kind === "deployment" && element.kind === "instance") {
    return "scopeId" in destination && destination.scopeId === element.instanceOf &&
      (destination.kind === "component" || destination.kind === "container");
  }
  return false;
}
export function diagramKindDiagnostics(
  index: ModelIndex,
  diagramId: string,
  kind: import("./model").Diagram["kind"],
): readonly Diagnostic[] {
  const actual = index.diagrams[diagramId]?.kind;
  return !actual || actual === kind ? [] : [{
    code: "diagram-kind",
    severity: "error",
    path: "$.diagramId",
    message: `Expected a ${kind} diagram, but "${diagramId}" is a ${actual} diagram.`,
  }];
}
