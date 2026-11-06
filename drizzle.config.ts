import { defineConfig } from "drizzle-kit";

// Used by `npm run db:generate` to write SQL migrations from src/db/schema.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
