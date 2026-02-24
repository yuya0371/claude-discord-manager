import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "common",
    include: ["tests/**/*.test.ts"],
  },
});
