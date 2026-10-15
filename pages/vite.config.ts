import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// INTERIM c4-sdk wiring. The copy under vendor/c4-sdk/ is reached ONLY through the package's public
// specifiers. At the npm swap (README "Swap to the npm package") delete these three aliases, the matching
// tsconfig paths and vendor/c4-sdk/, then add the c4-sdk dependency.
const vendored = (path: string) => fileURLToPath(new URL(`./vendor/c4-sdk/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^c4-sdk$/, replacement: vendored("src/index.ts") },
      { find: /^c4-sdk\/core$/, replacement: vendored("src/core/index.ts") },
      {
        find: /^c4-sdk\/styles\.css$/,
        replacement: vendored("src/lib/c4/styles/c4.css"),
      },
    ],
  },
  // The ELK layout worker alone is about 1.4 MB minified; the viewer chunk about 0.8 MB.
  build: { chunkSizeWarningLimit: 1600 },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
