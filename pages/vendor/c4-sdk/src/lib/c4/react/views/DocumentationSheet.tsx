import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
export function DocumentationSheet({ children }: { readonly children: ReactNode }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="c4-docs-trigger">Open explanation</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="c4-docs-backdrop" />
        <Dialog.Popup className="c4-sdk c4-docs-sheet">
          <Dialog.Title>Explanation</Dialog.Title>
          <Dialog.Close className="c4-docs-close">Close explanation</Dialog.Close>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
