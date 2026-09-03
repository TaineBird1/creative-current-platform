import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // convex-test runs functions in an edge-like runtime, same as production.
    environment: "edge-runtime",
    setupFiles: ["./vitest.setup.ts"],
    server: { deps: { inline: ["convex-test"] } },
    // scripts/ included so the redaction that keeps private keys out of logs
    // is covered. It leaked once already; an untested redactor is one nobody
    // has watched fail.
    include: [
      "convex/**/*.test.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
  resolve: {
    alias: { "@cc/site-config": path.resolve(__dirname, "packages/site-config/src/index.ts") },
  },
});
