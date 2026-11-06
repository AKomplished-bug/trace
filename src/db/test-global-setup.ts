import { runMigrations } from "./migrate";

/** Vitest global setup: migrate the test database once per run. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is required for integration tests (see .env.example)");
  if (url === process.env.DATABASE_URL) throw new Error("DATABASE_URL_TEST must not point at DATABASE_URL");
  await runMigrations(url);
}
