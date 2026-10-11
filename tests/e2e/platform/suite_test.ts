import { order } from "./seed.ts";
// Deno executes registered tests sequentially; dynamic imports control seeded registration order.
for (const scenario of order) await import(`./scenarios/${scenario}.ts`);
