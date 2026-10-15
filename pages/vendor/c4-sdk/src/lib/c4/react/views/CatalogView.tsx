import type { ReactNode } from "react";
import type { Catalog } from "../../ports/loader";
export interface CatalogViewProps {
  readonly title: string;
  readonly catalog?: Catalog;
  readonly resourceUrl?: string;
  readonly onResourceSelect: (url: string) => void;
  readonly statusText: string;
  readonly diagnosticsSlot: ReactNode;
  readonly viewerSlot: ReactNode;
}
export function CatalogView(
  { title, catalog, resourceUrl, onResourceSelect, statusText, diagnosticsSlot, viewerSlot }:
    CatalogViewProps,
) {
  return (
    <main className="c4-sdk c4-shell">
      <header className="c4-shell-heading">
        <div>
          <p className="c4-eyebrow">C4 SDK · Context preview</p>
          <h1>{title}</h1>
        </div>
        {catalog && (
          <label>
            Architecture resource<select
              value={resourceUrl ?? ""}
              onChange={(event) => onResourceSelect(event.target.value)}
            >
              {catalog.entries.map((entry) => (
                <option key={entry.id} value={entry.url}>{entry.title}</option>
              ))}
            </select>
          </label>
        )}
      </header>
      <p role="status">{statusText}</p>
      {diagnosticsSlot}
      {viewerSlot}
    </main>
  );
}
