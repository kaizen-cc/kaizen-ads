import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Renders the weekly report samples (scripts/report-samples/render.test.tsx); not part of the test suite
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "server-only": fileURLToPath(new URL("../../tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { include: ["scripts/report-samples/*.test.tsx"], environment: "node", env: { TZ: "America/New_York" }, testTimeout: 180_000 },
});
