// deno-lint-ignore-file jsx-button-has-type
import type { ContextViewProps } from "../contracts/views";
export function ContextView({ scene, canvasSlot, onDiagramSelect }: ContextViewProps) {
  return (
    <section className="c4-diagram" aria-label={scene.diagram.title}>
      <header className="c4-diagram-heading">
        <div>
          <p className="c4-eyebrow">{scene.kindLabel ?? "Diagram"} · {scene.statusText}</p>
          <h1 data-diagram-heading tabIndex={-1}>{scene.diagram.title}</h1>
        </div>
        <button onClick={onDiagramSelect}>Diagram explanation</button>
      </header>
      <p className="c4-hint">
        Open an element’s detail view or inspect its explanation. Scroll the diagram on narrow screens.
      </p>
      {canvasSlot}
      <details className="c4-relationships" open>
        <summary>Relationships ({scene.edges.length})</summary>
        <ul>
          {scene.edges.map((edge) => (
            <li key={edge.relationship.id}>
              <strong>{edge.source.element.name} → {edge.target.element.name}</strong>
              <span>
                {edge.number ? `${edge.number}. ` : ""}
                {edge.relationship.label} · {edge.relationship.technology ?? "Protocol not specified"} ·{" "}
                {edge.relationship.status}
              </span>
              {edge.relationship.plannedNotes.map((note) => <span key={note}>Planned: {note}</span>)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
