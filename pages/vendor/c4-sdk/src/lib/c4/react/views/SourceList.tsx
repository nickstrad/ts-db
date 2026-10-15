import type { SourceListProps } from "../contracts/views";
import { safeDocumentationUrl } from "../../domain/documentation";
export function SourceListView({ sources }: SourceListProps) {
  return sources.length
    ? (
      <div className="c4-sources">
        <h3>Sources</h3>
        <ul>
          {sources.map((source) => {
            const href = safeDocumentationUrl(source.url);
            return (
              <li key={source.id}>
                {href
                  ? (
                    <a
                      href={href}
                      target={href.startsWith("https:") ? "_blank" : undefined}
                      rel={href.startsWith("https:") ? "noopener noreferrer" : undefined}
                    >
                      {source.title}
                    </a>
                  )
                  : <span>{source.title}</span>}
                {source.revision && <p>Revision: {source.revision}</p>}
                {source.notes && <p>{source.notes}</p>}
              </li>
            );
          })}
        </ul>
      </div>
    )
    : null;
}
