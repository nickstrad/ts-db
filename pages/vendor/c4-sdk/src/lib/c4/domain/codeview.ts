import type { ArchitectureBundle, Diagnostic, Element, Id, ModelIndex } from "./model";

export const MAX_CODE_DEPTH = 32;
/** Valid IDs never contain `#`, so these keys cannot collide with each other or with another symbol's members. */
export const symbolKey = (elementId: Id) => `symbol:${elementId}`;
export const memberKey = (elementId: Id, index: number) => `${symbolKey(elementId)}#member-${index}`;

export type CodeAncestry =
  | { readonly ok: true; readonly ancestors: readonly Id[]; readonly componentId: Id }
  | { readonly ok: false; readonly reason: "missing" | "cycle" | "depth" | "parent-kind" };
/** Walks code parents to the owning component. Bounded and cycle-safe, including during validation. */
export function codeAncestry(elements: Readonly<Record<Id, Element>>, elementId: Id): CodeAncestry {
  const ancestors: Id[] = [];
  const seen = new Set<Id>([elementId]);
  let current = elements[elementId];
  while (current?.kind === "code") {
    const parentId = current.parentId;
    if (seen.has(parentId)) return { ok: false, reason: "cycle" };
    if (ancestors.length >= MAX_CODE_DEPTH) return { ok: false, reason: "depth" };
    seen.add(parentId);
    ancestors.push(parentId);
    const parent: Element | undefined = elements[parentId];
    if (!parent) return { ok: false, reason: "missing" };
    if (parent.kind === "component") return { ok: true, ancestors, componentId: parentId };
    if (parent.kind !== "code") return { ok: false, reason: "parent-kind" };
    current = parent;
  }
  return { ok: false, reason: "missing" };
}

const RICH_KINDS = new Set(["inheritance", "implementation", "composition"]);
/** Code containment, typed code relationships and code-view scope ancestry. */
export function validateCode(bundle: ArchitectureBundle, index: ModelIndex): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) =>
    diagnostics.push({ code, path, severity: "error", message });
  bundle.model.elements.forEach((element, i) => {
    if (element.kind !== "code") return;
    const path = `$.model.elements[${i}].parentId`;
    const result = codeAncestry(index.elements, element.id);
    if (result.ok) return;
    if (result.reason === "cycle") {
      error("code-cycle", path, "Code parents must form an acyclic chain ending at a component.");
    } else if (result.reason === "depth") {
      error("code-depth", path, `Code nesting exceeds ${MAX_CODE_DEPTH} levels.`);
    } else if (result.reason === "parent-kind") {
      error("invalid-parent", path, "A code element belongs to a component or another code element.");
    } else if (!index.elements[element.parentId]) {
      error("missing-reference", path, `Unknown reference "${element.parentId}".`);
    } else error("invalid-parent", path, "A code element belongs to a component or another code element.");
  });
  bundle.model.relationships.forEach((relationship, i) => {
    if (!RICH_KINDS.has(relationship.kind)) return;
    const path = `$.model.relationships[${i}]`;
    const source = index.elements[relationship.sourceId];
    const target = index.elements[relationship.targetId];
    if (!source || !target) return;
    if (source.kind !== "code" || target.kind !== "code") {
      error(
        "relationship-kind",
        `${path}.kind`,
        `A ${relationship.kind} relationship connects code elements only.`,
      );
    } else {
      if (relationship.kind === "inheritance" && source.id === target.id) {
        error("relationship-kind", `${path}.targetId`, "A symbol cannot inherit from itself.");
      }
      if (
        relationship.kind === "implementation" && target.symbolKind !== "interface" &&
        target.symbolKind !== "type"
      ) {
        error(
          "relationship-kind",
          `${path}.targetId`,
          "An implementation targets an interface or type symbol.",
        );
      }
    }
  });
  bundle.diagrams.forEach((diagram, i) => {
    if (diagram.kind !== "code") return;
    diagram.nodes.forEach((member, j) => {
      const element = index.elements[member.elementId];
      if (element?.kind !== "code" || element.tags.includes("external")) return;
      const result = codeAncestry(index.elements, element.id);
      if (!result.ok || result.componentId !== diagram.scopeId) {
        error(
          "code-scope",
          `$.diagrams[${i}].nodes[${j}].elementId`,
          "A code member must belong to the scoped component, or be tagged external.",
        );
      }
    });
  });
  return diagnostics;
}
