import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    hookTimeout: 60000,
  },
})
