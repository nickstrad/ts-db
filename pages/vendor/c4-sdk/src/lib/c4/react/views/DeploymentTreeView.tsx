// deno-lint-ignore-file jsx-button-has-type
import type { DestinationLinkProps } from "../contracts/views";
import "../../styles/deployment.css";
export interface DeploymentTreeProps {
  readonly environment: string;
  readonly hiddenCount: number;
  readonly relationships: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly label: string;
    readonly status: string;
  }[];
  readonly rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: string;
    readonly depth: number;
    readonly parent?: string;
    readonly logical?: string;
    readonly kind: string;
    readonly selected: boolean;
    readonly collapsed: boolean;
    readonly onToggle: () => void;
    readonly onInspect: () => void;
    readonly detail?: DestinationLinkProps;
  }[];
}
/** Full physical inventory remains accessible even when canvas descendants are hidden. */
export function DeploymentTreeView({ environment, hiddenCount, rows, relationships }: DeploymentTreeProps) {
  return (
    <section className="c4-deployment-tree" aria-label="Deployment topology">
      <h2>Deployment · {environment}</h2>
      <p>
        Expand or collapse physical boundaries in this view. {hiddenCount}{" "}
        elements hidden on canvas. The complete inventory below remains available; inspecting an element
        reveals its ancestors.
      </p>
      <ul>
        {rows.map((row) => (
          <li
            key={row.id}
            data-deployment-id={row.id}
            data-selected={row.selected}
            style={{ paddingInlineStart: `${Math.min(row.depth, 5) * 0.75}rem` }}
          >
            <div>
              <strong>{row.name}</strong>{" "}
              <small>{row.id} · {row.status}{row.parent && ` · inside ${row.parent}`}</small>
            </div>
            {row.logical && <p>Instance of {row.logical}</p>}
            <div className="c4-deployment-actions">
              {row.kind === "deploymentNode" && (
                <button
                  onClick={row.onToggle}
                  aria-expanded={!row.collapsed}
                  aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.name}`}
                >
                  {row.collapsed ? "Expand" : "Collapse"}
                </button>
              )}
              <button
                aria-pressed={row.selected}
                onClick={row.onInspect}
                aria-label={`Inspect topology ${row.name}`}
              >
                Inspect
              </button>
              {row.detail && <a {...row.detail}>Open logical detail for {row.name}</a>}
            </div>
          </li>
        ))}
      </ul>
      <details>
        <summary>All declared deployment relationships ({relationships.length})</summary>
        <ul>
          {relationships.map((edge) => (
            <li key={edge.id}>{edge.source} → {edge.target}: {edge.label} · {edge.status}</li>
          ))}
        </ul>
        <p>
          Relationships incident to collapsed descendants are omitted from the canvas; their declared
          endpoints remain listed here.
        </p>
      </details>
    </section>
  );
}
