// deno-lint-ignore-file jsx-button-has-type
import type { InteractionOverlay, ScenarioItem } from "../../domain/scenario";
export function StepListView(
  { tree, selectedId, onSelect, overlays }: {
    readonly tree: ScenarioItem;
    readonly selectedId?: string;
    readonly onSelect: (id: string | undefined) => void;
    readonly overlays: readonly InteractionOverlay[];
  },
) {
  return (
    <section className="c4-step-list" aria-label="Scenario text alternative">
      <h2>Scenario structure</h2>
      <p>
        Sequence children follow in order. Each parallel branch keeps its own sequence; there is no lockstep
        barrier between branches.
      </p>
      <StepTree item={tree} selectedId={selectedId} onSelect={onSelect} />
      <div aria-live="polite" className="c4-selected-interactions">
        <h3>Selected interactions</h3>
        <p>
          {overlays.length > 1
            ? "These interactions belong to the selected scope. Showing them together does not imply simultaneous execution."
            : overlays.length
            ? "Arrow direction follows the selected interaction."
            : "Select a step to inspect its interactions."}
        </p>
        <ul>
          {overlays.map((item) => (
            <li key={item.id} data-interaction-id={item.id}>
              <strong>{item.number} · {item.sourceName} → {item.targetName}</strong>
              <span>
                {item.label} ·{" "}
                {item.direction === "reverse"
                  ? "Reverse of the model relationship"
                  : "Forward model direction"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
function StepTree(
  { item, selectedId, onSelect }: {
    readonly item: ScenarioItem;
    readonly selectedId?: string;
    readonly onSelect: (id: string | undefined) => void;
  },
) {
  return (
    <div className={`c4-step-tree c4-step-${item.kind}`}>
      <button aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
        {item.number} · {item.label}
      </button>
      {item.children.length > 0 && (
        <ol
          aria-label={item.kind === "parallel" ? "Unordered parallel branches" : "Ordered sequence children"}
        >
          {item.children.map((child) => (
            <li key={child.id}>
              <StepTree item={child} selectedId={selectedId} onSelect={onSelect} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
