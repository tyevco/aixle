import { defineConfig } from "vitest/config";

// Tests that mesh, bake or render take a second or more here and two to three times that on a CI runner, so the
// default 5 s timeout failed a 4.4 s render test there; a test that is really stuck still fails at 30 s.
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000 },
});
