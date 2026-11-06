import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Integration tests read DATABASE_URL_TEST from .env when it isn't already set.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/db/test-global-setup.ts"],
    // Integration tests share one test database.
    fileParallelism: false,
    env: { LOG_LEVEL: "silent" },
  },
});
