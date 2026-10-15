import type { DiagnosticViewProps } from "../contracts/views";
export function DiagnosticView({ diagnostics }: DiagnosticViewProps) {
  return diagnostics.length
    ? (
      <section className="c4-diagnostics" role="status" aria-label="Resource diagnostics">
        <h2>Resource diagnostics</h2>
        <ul>
          {diagnostics.map((item, i) => (
            <li key={`${item.path}-${item.code}-${i}`}>
              <strong>{item.severity}: {item.code}</strong>
              <code>{item.path}</code>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      </section>
    )
    : null;
}
