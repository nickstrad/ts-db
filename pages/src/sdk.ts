/**
 * The ONLY module of the site that touches c4-sdk. Everything else imports SDK components, ports and
 * types from here, so the swap from the interim copy (vendor/c4-sdk, reached through Vite/TS aliases) to the
 * published npm package edits this file alone. See README.md, "Swap to the npm package".
 */
import "c4-sdk/styles.css";
import {
  ArchitectureProvider,
  ArchitectureViewer,
  createElkLayoutPort,
  createFetchLoader,
  createHashRoutePort,
  DiagramDocumentation,
  DiagramNavigation,
  DiagramView,
} from "c4-sdk";
import { formatRoute, parseRoute } from "c4-sdk/core";
import type {
  CatalogEntry,
  Diagnostic,
  Diagram,
  Result,
  Route,
  RoutePort,
  RouteSnapshot,
  ValidatedArchitecture,
} from "c4-sdk/core";

export {
  ArchitectureProvider,
  ArchitectureViewer,
  DiagramDocumentation,
  DiagramNavigation,
  DiagramView,
  formatRoute,
  parseRoute,
};
export type { CatalogEntry, Diagnostic, Diagram, Route, RoutePort, ValidatedArchitecture };

/**
 * One layout port for every viewer on the page. In source mode the SDK bundles its ELK worker itself.
 * At the npm swap this becomes
 * `createElkLayoutPort(() => new Worker(layoutWorkerUrl, { type: "module" }))` with
 * `import layoutWorkerUrl from "c4-sdk/layout-worker.js?url"`.
 */
export const layoutPort = createElkLayoutPort();

const loader = createFetchLoader();

let browserPort: RoutePort | undefined;
/** The URL-hash route port, created on first use so importing this module touches no browser state. */
export function browserRoutePort(): RoutePort {
  browserPort ??= createHashRoutePort();
  return browserPort;
}

/** A route port that keeps its history in memory: the second (and first) viewer of the side-by-side mode. */
export interface MemoryRoutePort extends RoutePort {
  /** The route currently shown. */
  readonly route: () => Route;
}

/**
 * Implements the public `RoutePort` contract without touching the URL: a stack of routes, `push` adds an
 * entry, `replace` rewrites the top, `back` pops while more than one entry remains. Like the SDK's hash
 * port, writing the route already shown is a no-op, and the snapshot object stays stable until it changes.
 */
export function createMemoryRoutePort(initial: Route): MemoryRoutePort {
  const stack: Route[] = [initial];
  const listeners = new Set<() => void>();
  const snapshotOf = (): RouteSnapshot => ({
    hash: formatRoute(stack.at(-1)!),
    canGoBack: stack.length > 1,
  });
  let snapshot = snapshotOf();
  const publish = () => {
    snapshot = snapshotOf();
    listeners.forEach((listener) => listener());
  };
  return {
    route: () => stack.at(-1)!,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push: (route) => {
      if (formatRoute(route) === snapshot.hash) return;
      stack.push(route);
      publish();
    },
    replace: (route) => {
      if (formatRoute(route) === snapshot.hash) return;
      stack[stack.length - 1] = route;
      publish();
    },
    back: () => {
      if (stack.length < 2) return;
      stack.pop();
      publish();
    },
  };
}

/** A catalog entry with its decoded bundle, or the reason it could not be shown. */
export interface LoadedArchitecture {
  readonly entry: CatalogEntry;
  readonly result: Result<ValidatedArchitecture>;
}

/**
 * Loads the catalog and every bundle it lists through the SDK's bounded fetch loader. Like the SDK's
 * CatalogViewer, a bundle whose `id` differs from its catalog entry `id` is rejected, so a deep link's
 * architecture id always names the bundle it shows.
 */
export async function loadArchitectures(
  catalogUrl: string,
  signal: AbortSignal,
): Promise<readonly LoadedArchitecture[]> {
  const catalog = await loader.loadCatalog(catalogUrl, signal);
  return await Promise.all(
    catalog.entries.map(async (entry): Promise<LoadedArchitecture> => {
      const result = await loader.loadBundle(entry.url, signal);
      if (result.ok && result.value.bundle.id !== entry.id) {
        return {
          entry,
          result: {
            ok: false,
            diagnostics: [{
              code: "catalog-identity",
              severity: "error",
              path: "$.id",
              message: `Catalog entry "${entry.id}" loaded a bundle whose id is "${result.value.bundle.id}".`,
            }],
          },
        };
      }
      return { entry, result };
    }),
  );
}
