import { useState } from "react";
import type { DocumentSelection } from "../../domain/documentation";
import { selectDocument, selectDocumentReferences } from "../../domain/documentation";
export function useDocumentation(selection: DocumentSelection, identity: string) {
  const [choice, setChoice] = useState<{ identity: string; id: string }>();
  const [mode, setMode] = useState<"plain" | "ste">("plain");
  const document = selectDocument(selection, choice?.identity === identity ? choice.id : undefined);
  return {
    selection: selectDocumentReferences(selection, document),
    document,
    documentId: document?.id,
    mode,
    onDocument: (id: string) => setChoice({ identity, id }),
    onPlain: () => setMode("plain"),
    onSte: () => setMode("ste"),
  };
}
