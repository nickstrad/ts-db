// deno-lint-ignore-file jsx-button-has-type
import Markdown from "react-markdown";
import type { DocumentationViewProps } from "../contracts/views";
import { safeDocumentationUrl } from "../../domain/documentation";
import { SourceListView } from "./SourceList";
import { DocumentationSheet } from "./DocumentationSheet";
import "../../styles/documentation.css";
export { SourceListView } from "./SourceList";
function Explanation({ selection, mode, onPlain, onSte, document, onDocument }: DocumentationViewProps) {
  const doc = document ?? selection.documents[0];
  return (
    <section className="c4-documentation" aria-label="Explanation">
      <p className="c4-eyebrow">Inspect</p>
      <h2>{selection.title}</h2>
      {selection.statusText && <p className="c4-status">{selection.statusText}</p>}
      {selection.description && <p>{selection.description}</p>}
      {selection.plannedNotes.map((note) => <p key={note}>Planned: {note}</p>)}
      {selection.documents.length > 1 && (
        <label>
          Document<select
            aria-label="Document"
            value={doc?.id}
            onChange={(event) => onDocument?.(event.target.value)}
          >
            {selection.documents.map((document) => (
              <option key={document.id} value={document.id}>{document.title}</option>
            ))}
          </select>
        </label>
      )}
      <div className="c4-text-switch" role="group" aria-label="Explanation format">
        <button aria-pressed={mode === "plain"} onClick={onPlain}>Plain explanation</button>
        <button aria-pressed={mode === "ste"} onClick={onSte}>STE100 text</button>
      </div>
      {doc
        ? (
          <article>
            <h3>{doc.title}</h3>
            {mode === "ste" && (
              <p className="c4-review">
                {doc.ste.issue} · {doc.ste.reviewStatus}
                {doc.ste.reviewer ? ` · ${doc.ste.reviewer}` : ""}
                {doc.ste.reviewedAt ? ` · ${doc.ste.reviewedAt}` : ""}
              </p>
            )}
            <div className="c4-prose">
              <Markdown
                skipHtml
                allowedElements={[
                  "p",
                  "h1",
                  "h2",
                  "h3",
                  "h4",
                  "h5",
                  "h6",
                  "ul",
                  "ol",
                  "li",
                  "strong",
                  "em",
                  "code",
                  "a",
                  "br",
                  "blockquote",
                ]}
                urlTransform={(url) => safeDocumentationUrl(url) ?? ""}
                components={{
                  a: ({ href, children }) =>
                    href
                      ? (
                        <a
                          href={href}
                          target={href.startsWith("https:") ? "_blank" : undefined}
                          rel={href.startsWith("https:") ? "noopener noreferrer" : undefined}
                        >
                          {children}
                        </a>
                      )
                      : <span>{children}</span>,
                }}
              >
                {mode === "plain" ? doc.plain : doc.ste.text}
              </Markdown>
            </div>
          </article>
        )
        : <p>No explanation is provided for this element.</p>}
      {selection.terms.length > 0 && (
        <div>
          <h3>Technical terms</h3>
          <dl>
            {selection.terms.map((term) => (
              <div key={term.id}>
                <dt>{term.text}</dt>
                <dd>{term.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <SourceListView sources={selection.sources} />
    </section>
  );
}
export function DocumentationView(props: DocumentationViewProps) {
  return (
    <div className="c4-docs-responsive">
      <div className="c4-docs-inline">
        <Explanation {...props} />
      </div>
      <div className="c4-docs-mobile">
        <DocumentationSheet>
          <Explanation {...props} />
        </DocumentationSheet>
      </div>
    </div>
  );
}
