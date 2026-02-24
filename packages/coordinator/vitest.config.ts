import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "coordinator",
    include: ["tests/**/*.test.ts"],
  },
});
