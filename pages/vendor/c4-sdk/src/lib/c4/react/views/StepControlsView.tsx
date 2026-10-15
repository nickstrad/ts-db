// deno-lint-ignore-file jsx-button-has-type
import type { ScenarioItem } from "../../domain/scenario";
import "../../styles/dynamic.css";
export interface StepControlsProps {
  readonly selections: readonly ScenarioItem[];
  readonly selectedId?: string;
  readonly onSelect: (id: string | undefined) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly previousDisabled: boolean;
  readonly nextDisabled: boolean;
}
export function StepControlsView(props: StepControlsProps) {
  return (
    <section className="c4-step-controls" aria-label="Scenario selections">
      <h2>Read the scenario</h2>
      <p>
        Numbers identify positions in the scenario tree. Reading selections are not an execution timeline.
        Parallel branches have no order between them.
      </p>
      <div>
        <button onClick={props.onPrevious} disabled={props.previousDisabled}>Previous selection</button>
        <label>
          Scenario step<select
            aria-label="Scenario step"
            value={props.selectedId ?? ""}
            onChange={(event) => props.onSelect(event.target.value || undefined)}
          >
            <option value="">No step selected</option>
            {props.selections.map((item) => (
              <option key={item.id} value={item.id}>{item.number} · {item.label}</option>
            ))}
          </select>
        </label>
        <button onClick={props.onNext} disabled={props.nextDisabled}>Next selection</button>
      </div>
    </section>
  );
}
