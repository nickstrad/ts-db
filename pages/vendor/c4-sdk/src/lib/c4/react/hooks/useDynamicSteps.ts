import type { ModelIndex } from "../../domain/model";
import type { NavigationAction, Route } from "../../domain/navigation";
import {
  adjacentSelection,
  readingSelections,
  scenarioItems,
  selectInteractions,
} from "../../domain/scenario";
export function useDynamicSteps(
  index: ModelIndex,
  route: Route,
  navigate: (action: NavigationAction) => void,
) {
  const diagram = index.diagrams[route.diagramId];
  if (diagram?.kind !== "dynamic") return undefined;
  const tree = scenarioItems(diagram.scenario);
  const selections = readingSelections(tree);
  const selected = selections.find((item) => item.id === route.stepId);
  const previous = adjacentSelection(tree, route.stepId, -1);
  const next = adjacentSelection(tree, route.stepId, 1);
  return {
    tree,
    selectedId: route.stepId,
    selected,
    overlays: selectInteractions(index, diagram, route.stepId),
    selections,
    onSelect: (stepId: string | undefined) => navigate({ type: "step", stepId }),
    onPrevious: () => {
      if (previous) navigate({ type: "step", stepId: previous });
    },
    onNext: () => {
      if (next) navigate({ type: "step", stepId: next });
    },
    previousDisabled: !previous,
    nextDisabled: !next,
  };
}
