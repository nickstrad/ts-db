import type { LegendProps } from "../contracts/views";
export function Legend({ title, entries, compact }: LegendProps) {
  return (
    <section className={`c4-legend${compact ? " c4-compact" : ""}`} aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span
              aria-hidden="true"
              className={`c4-swatch c4-tone-${entry.swatch.tone} c4-stroke-${entry.swatch.stroke} c4-shape-${
                entry.swatch.shape ?? "box"
              }`}
            >
              {entry.swatch.arrow === "forward" ? "→" : entry.swatch.shape === "person" ? "●" : ""}
            </span>
            <span>
              <strong>{entry.label}</strong>
              <span className="c4-key-description">{entry.description}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
