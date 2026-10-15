import type { Result, ValidatedArchitecture } from "../domain/model";
export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}
export interface Catalog {
  readonly entries: readonly CatalogEntry[];
}
export interface ArchitectureLoader {
  loadCatalog(url: string, signal: AbortSignal): Promise<Catalog>;
  loadBundle(url: string, signal: AbortSignal): Promise<Result<ValidatedArchitecture>>;
}
