import type { Document, LegendSpec, ModelIndex, Source, Term } from "./model";
import { statusLabel } from "./scene";
export interface DocumentSelection {
  readonly itemSourceIds?: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly statusText?: string;
  readonly plannedNotes: readonly string[];
  readonly documents: readonly Document[];
  readonly sources: readonly Source[];
  readonly terms: readonly Term[];
}
export function selectDocumentation(
  index: ModelIndex,
  diagramId: string,
  elementId?: string,
): DocumentSelection {
  const visible = !elementId ||
    index.diagrams[diagramId]?.nodes.some((member) => member.elementId === elementId);
  const item = visible ? elementId ? index.elements[elementId] : index.diagrams[diagramId] : undefined;
  const documents = (item?.docIds ?? []).map((id) => index.documents[id]).filter((doc): doc is Document =>
    !!doc
  );
  const sourceIds = new Set([...(item?.sourceIds ?? []), ...documents.flatMap((doc) => doc.sourceIds)]);
  const termIds = new Set(documents.flatMap((doc) => doc.termIds));
  return {
    itemSourceIds: item?.sourceIds ?? [],
    plannedNotes: elementId && visible ? index.elements[elementId]?.plannedNotes ?? [] : [],
    statusText: item ? statusLabel(item.status) : undefined,
    title: elementId
      ? visible ? index.elements[elementId]?.name ?? "Unknown element" : "Element is not in this diagram"
      : index.diagrams[diagramId]?.title ?? "Unknown diagram",
    description: elementId && visible ? index.elements[elementId]?.description : undefined,
    documents,
    sources: [...sourceIds].map((id) => index.sources[id]).filter((source): source is Source => !!source),
    terms: [...termIds].map((id) => index.terms[id]).filter((term): term is Term => !!term),
  };
}
export function resolveLegend(index: ModelIndex, diagramId: string): LegendSpec | undefined {
  return index.diagrams[diagramId]?.legend;
}

/** A stale document identifier never crosses selection boundaries. */
export function selectDocument(selection: DocumentSelection, documentId?: string): Document | undefined {
  return selection.documents.find((doc) => doc.id === documentId) ?? selection.documents[0];
}
/** Runs on the Markdown parser's decoded URL, before a browser sees it. */
export function safeDocumentationUrl(value: string): string | undefined {
  if (
    !value || /[\s\\]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) return undefined;
  if (value.startsWith("#")) return value;
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("/") || /^[^/?#]*:/.test(value) || value.includes("%")) return undefined;
  return value.split(/[/?#]/).some((part) => part === ".." || part === ".") ? undefined : value;
}

export function selectDocumentReferences(selection: DocumentSelection, doc?: Document): DocumentSelection {
  const sourceIds = new Set([...(selection.itemSourceIds ?? []), ...(doc?.sourceIds ?? [])]);
  const termIds = new Set(doc?.termIds ?? []);
  return {
    ...selection,
    sources: selection.sources.filter((source) => sourceIds.has(source.id)),
    terms: selection.terms.filter((term) => termIds.has(term.id)),
  };
}
