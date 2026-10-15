import { formatRoute } from "../../domain/navigation";
import type { Route } from "../../domain/navigation";
import type { RoutePort, RouteSnapshot } from "../../ports/route";
/** Tracks only same-session viewer entry depth in browser state, never a second route stack. */
export function createHashRoutePort(browser: Window = window): RoutePort {
  const sessionKey = `c4-viewer:${browser.location.pathname}`;
  let owner: string;
  try {
    owner = browser.sessionStorage.getItem(sessionKey) ?? `c4-${Math.random().toString(36).slice(2)}`;
    browser.sessionStorage.setItem(sessionKey, owner);
  } catch {
    owner = `c4-${Math.random().toString(36).slice(2)}`;
  }
  const listeners = new Set<() => void>();
  const position = () =>
    browser.history.state?.c4Viewer?.owner === owner ? browser.history.state.c4Viewer.depth as number : 0;
  let snapshot: RouteSnapshot = { hash: browser.location.hash, canGoBack: position() > 0 };
  const update = () => {
    snapshot = { hash: browser.location.hash, canGoBack: position() > 0 };
    listeners.forEach((listener) => listener());
  };
  const write = (route: Route, replace: boolean) => {
    const hash = formatRoute(route);
    if (hash === browser.location.hash) return;
    const state = { ...browser.history.state, c4Viewer: { owner, depth: position() + (replace ? 0 : 1) } };
    browser.history[replace ? "replaceState" : "pushState"](state, "", hash);
    update();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        browser.addEventListener("popstate", update);
        browser.addEventListener("hashchange", update);
        update();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          browser.removeEventListener("popstate", update);
          browser.removeEventListener("hashchange", update);
        }
      };
    },
    push: (route) => write(route, false),
    replace: (route) => write(route, true),
    back: () => {
      if (position() > 0) browser.history.back();
    },
  };
}
