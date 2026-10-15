import { useEffect, useState } from "react";
import type { Diagnostic, ValidatedArchitecture } from "../../domain/model";
import { loadingFailure, resourceStatus } from "../../domain/presentation";
import type { ArchitectureLoader, Catalog } from "../../ports/loader";
export interface ArchitectureLoadOptions {
  readonly architectureId?: string;
  readonly resourceUrl?: string;
  readonly onAccepted?: (architecture: ValidatedArchitecture, resourceUrl: string) => void;
  readonly requireCatalogIdentity?: boolean;
}
export function useArchitectureBundle(
  loader: ArchitectureLoader,
  catalogUrl: string,
  options: ArchitectureLoadOptions = {},
) {
  const { architectureId, resourceUrl: requestedResourceUrl, onAccepted, requireCatalogIdentity = false } =
    options;
  const [catalogState, setCatalog] = useState<{ url: string; catalog: Catalog }>();
  const [resource, setResource] = useState<{ catalogUrl: string; url: string }>();
  const [architecture, setArchitecture] = useState<ValidatedArchitecture>();
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [pending, setPending] = useState(true);
  const catalog = catalogState?.url === catalogUrl ? catalogState.catalog : undefined;
  const resourceUrl = requestedResourceUrl ??
    catalog?.entries.find((entry) => entry.id === architectureId)?.url ??
    (resource?.catalogUrl === catalogUrl ? resource.url : undefined);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // External resource lifecycle begins here; expose pending before its promise completes.
    // eslint-disable-next-line react/set-state-in-effect
    setPending(true);
    setDiagnostics([]);
    loader.loadCatalog(catalogUrl, controller.signal).then((value) => {
      if (active) {
        setCatalog({ url: catalogUrl, catalog: value });
        setResource({ catalogUrl, url: value.entries[0].url });
      }
    }).catch((error: unknown) => {
      if (active) {
        setDiagnostics(
          loadingFailure(error instanceof Error ? error.message : "Catalog could not be loaded."),
        );
        setPending(false);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loader, catalogUrl]);
  const expectedId = requireCatalogIdentity
    ? catalog?.entries.find((entry) => entry.url === resourceUrl)?.id
    : undefined;
  useEffect(() => {
    if (!resourceUrl) return;
    const controller = new AbortController();
    let active = true;
    // External resource lifecycle begins here; expose pending before its promise completes.
    // eslint-disable-next-line react/set-state-in-effect
    setPending(true);
    setDiagnostics([]);
    loader.loadBundle(resourceUrl, controller.signal).then((result) => {
      if (!active) return;
      if (result.ok && expectedId && result.value.bundle.id !== expectedId) {
        setDiagnostics([{
          code: "catalog-identity",
          path: "$.id",
          severity: "error",
          message: `Architecture ID "${result.value.bundle.id}" does not match catalog ID "${expectedId}".`,
        }]);
        setPending(false);
        return;
      }
      if (result.ok) {
        setArchitecture(result.value);
        onAccepted?.(result.value, resourceUrl);
      }
      setDiagnostics(result.diagnostics);
      setPending(false);
    }).catch((error: unknown) => {
      if (active) {
        setDiagnostics(
          loadingFailure(error instanceof Error ? error.message : "Architecture could not be loaded."),
        );
        setPending(false);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loader, catalogUrl, resourceUrl, expectedId, onAccepted]);
  return {
    catalog,
    resourceUrl,
    architecture,
    diagnostics,
    pending,
    statusText: resourceStatus(pending, architecture, diagnostics),
    onResourceSelect: (url: string) => setResource({ catalogUrl, url }),
  };
}
