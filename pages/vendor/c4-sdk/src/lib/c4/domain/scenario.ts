import type { Diagnostic, DynamicDiagram, InteractionStep, ModelIndex, Step } from "./model";
export interface ScenarioItem {
  readonly id: string;
  readonly label: string;
  readonly kind: Step["kind"];
  readonly number: string;
  readonly children: readonly ScenarioItem[];
  readonly interaction?: InteractionStep;
}
export function scenarioItems(step: Step, number = "1"): ScenarioItem {
  const children = step.kind === "sequence" ? step.children : step.kind === "parallel" ? step.branches : [];
  return {
    id: step.id,
    kind: step.kind,
    label: step.kind === "interaction"
      ? step.label
      : step.kind === "parallel"
      ? "Parallel branches (no order between branches)"
      : "Sequence (children follow in order)",
    number,
    interaction: step.kind === "interaction" ? step : undefined,
    children: children.map((child, i) =>
      scenarioItems(child, `${number}.${step.kind === "parallel" ? "B" : ""}${i + 1}`)
    ),
  };
}
export function readingSelections(root: ScenarioItem): readonly ScenarioItem[] {
  return [root, ...root.children.flatMap(readingSelections)];
}
export function interactions(step: Step): readonly InteractionStep[] {
  return step.kind === "interaction"
    ? [step]
    : (step.kind === "sequence" ? step.children : step.branches).flatMap(interactions);
}
export function findStep(root: Step, id: string): Step | undefined {
  if (root.id === id) return root;
  if (root.kind === "interaction") return undefined;
  for (const child of root.kind === "sequence" ? root.children : root.branches) {
    const found = findStep(child, id);
    if (found) return found;
  }
  return undefined;
}
/** Analysis-only complete precedence relation (not used in rendering). At the
 * 1000-step boundary it can contain about 500,000 pairs. Complete precedence relation. Sequence children finish before later children;
 * no relationship is added between the children of a parallel group. */
export function precedence(root: Step): readonly (readonly [string, string])[] {
  if (root.kind === "interaction") return [];
  const children = root.kind === "sequence" ? root.children : root.branches;
  const result: (readonly [string, string])[] = children.flatMap(precedence);
  if (root.kind === "sequence") {
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        for (const a of interactions(children[i])) {
          for (const b of interactions(children[j])) result.push([a.id, b.id]);
        }
      }
    }
  }
  return result;
}
export function validateScenario(diagram: DynamicDiagram, index: ModelIndex, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const pending = [{ step: diagram.scenario, depth: 1, path: `${path}.scenario` }];
  let count = 0;
  const declared = new Set(diagram.edges.map((edge) => edge.relationshipId));
  while (pending.length) {
    const current = pending.pop()!;
    const step = current.step;
    if (++count > 1000 || current.depth > 32) {
      diagnostics.push({
        code: "scenario-limit",
        severity: "error",
        path: current.path,
        message: "A scenario permits at most 1000 steps and depth 32.",
      });
      break;
    }
    if (seen.has(step.id)) {
      diagnostics.push({
        code: "duplicate-step",
        severity: "error",
        path: current.path,
        message: `Duplicate scenario step "${step.id}".`,
      });
      continue;
    }
    seen.add(step.id);
    if (step.kind === "interaction") {
      if (!declared.has(step.relationshipId) || !index.relationships[step.relationshipId]) {
        diagnostics.push({
          code: "scenario-reference",
          severity: "error",
          path: `${current.path}.relationshipId`,
          message: "Interaction must refer to a declared visible relationship.",
        });
      }
    } else {
      const children = step.kind === "sequence" ? step.children : step.branches;
      if (!children.length) {
        diagnostics.push({
          code: "empty-scenario",
          severity: "error",
          path: current.path,
          message: "Scenario groups must contain steps.",
        });
      }
      children.forEach((child, i) =>
        pending.push({
          step: child,
          depth: current.depth + 1,
          path: `${current.path}.${step.kind === "sequence" ? "children" : "branches"}[${i}]`,
        })
      );
    }
  }
  return diagnostics;
}
export interface InteractionOverlay {
  readonly id: string;
  readonly relationshipId: string;
  readonly number: string;
  readonly label: string;
  readonly direction: "forward" | "reverse";
  readonly sourceName: string;
  readonly targetName: string;
}
export function selectInteractions(
  index: ModelIndex,
  diagram: DynamicDiagram,
  stepId?: string,
): readonly InteractionOverlay[] {
  const selected = stepId ? findStep(diagram.scenario, stepId) : undefined;
  if (!selected) return [];
  const numbers = new Map(
    readingSelections(scenarioItems(diagram.scenario)).map((item) => [item.id, item.number]),
  );
  return interactions(selected).map((step) => {
    const relationship = index.relationships[step.relationshipId];
    const source =
      index.elements[step.direction === "forward" ? relationship.sourceId : relationship.targetId];
    const target =
      index.elements[step.direction === "forward" ? relationship.targetId : relationship.sourceId];
    return {
      id: step.id,
      relationshipId: step.relationshipId,
      number: numbers.get(step.id)!,
      label: step.label,
      direction: step.direction,
      sourceName: source.name,
      targetName: target.name,
    };
  });
}
export function adjacentSelection(
  root: ScenarioItem,
  id: string | undefined,
  delta: -1 | 1,
): string | undefined {
  const items = readingSelections(root);
  const current = id ? items.findIndex((item) => item.id === id) : -1;
  return items[current + delta]?.id;
}
