import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "worker",
    include: ["tests/**/*.test.ts"],
  },
});
