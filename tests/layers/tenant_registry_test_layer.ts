/** Existing HTTP tests must fail if they unexpectedly call the tenant registry. */
import { Effect, Layer } from "effect";
import { TenantRegistry } from "../../platform/services.ts";

export const UnusedTenantRegistry = Layer.succeed(TenantRegistry, {
  createTenant: () => Effect.die("unexpected tenant registry call"),
  getTenant: () => Effect.die("unexpected tenant registry call"),
  listTenants: () => Effect.die("unexpected tenant registry call"),
  updateTenant: () => Effect.die("unexpected tenant registry call"),
  deactivateTenant: () => Effect.die("unexpected tenant registry call"),
  issueApiKey: () => Effect.die("unexpected tenant registry call"),
  revokeApiKey: () => Effect.die("unexpected tenant registry call"),
  resolveTenantByKeyHash: () => Effect.die("unexpected tenant registry call"),
});
