// deno-lint-ignore-file jsx-button-has-type
import type { SceneInput } from "../../domain/scene";
import type { DiagramCanvasProps } from "../contracts/views";
import { CodeMembers } from "./CodeMembers";
/** The text alternative stays useful while a worker is unavailable or still running. */
export function DiagramFallback(
  { input, nodeActions, ready }: {
    ready: boolean;
    input: SceneInput;
    nodeActions: (id: string) => Pick<DiagramCanvasProps["nodes"][number], "detail" | "onInspect">;
  },
) {
  return (
    <section
      className="c4-layout-fallback"
      data-layout-ready={ready || undefined}
      aria-label={`${input.diagram.title} text alternative`}
    >
      <h1 data-diagram-heading tabIndex={-1}>{input.diagram.title}</h1>
      <h2>Elements</h2>
      <ul>
        {input.nodes.map((node) => {
          const actions = nodeActions(node.element.id);
          return (
            <li key={node.element.id}>
              {actions.detail
                ? (
                  <a
                    {...actions.detail}
                    aria-label={`Open detail for ${node.element.name}`}
                    data-element-id={node.element.id}
                  >
                    {node.element.name} — Open detail
                  </a>
                )
                : <strong>{node.element.name}</strong>}
              <p>{node.kindLabel} · {node.statusText}. {node.element.description}</p>
              <CodeMembers element={node.element} />
              <button
                onClick={actions.onInspect}
                data-element-id={actions.detail ? undefined : node.element.id}
                aria-label={`Inspect ${node.element.name}`}
              >
                Inspect {node.element.name}
              </button>
            </li>
          );
        })}
      </ul>
      {input.groups.length > 0 && (
        <>
          <h2>Boundaries</h2>
          <ul>
            {input.groups.map((group) => (
              <li key={group.id}>
                {group.label} · {group.status}
                {group.parentGroupId
                  ? ` · inside ${input.groups.find((parent) => parent.id === group.parentGroupId)?.label}`
                  : ""}
                <p>
                  {group.memberIds.map((id) =>
                    input.nodes.find((node) => node.element.id === id)?.element.name
                  ).join(", ") || "No direct members"}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Relationships ({input.edges.length})</h2>
      <ul>
        {input.edges.map((edge) => (
          <li key={edge.relationship.id}>
            {edge.number ? `${edge.number}. ` : ""}
            <strong>
              {input.nodes.find((node) => node.element.id === edge.relationship.sourceId)?.element.name} →
              {" "}
              {input.nodes.find((node) => node.element.id === edge.relationship.targetId)?.element.name}
            </strong>
            <p>
              {edge.relationship.label} ·{" "}
              {edge.relationship.kind !== "dependency" ? `${edge.relationship.kind} · ` : ""}
              {edge.relationship.technology ?? "Protocol not specified"} · {edge.relationship.status}
            </p>
            {edge.relationship.plannedNotes.map((note) => <p key={note}>Planned: {note}</p>)}
          </li>
        ))}
      </ul>
    </section>
  );
}
