import type { Route } from "../domain/navigation";
export interface RouteSnapshot {
  readonly hash: string;
  readonly canGoBack: boolean;
}
export interface RoutePort {
  readonly getSnapshot: () => RouteSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly push: (route: Route) => void;
  readonly replace: (route: Route) => void;
  readonly back: () => void;
}
