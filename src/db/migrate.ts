import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client";

export const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

/** Applies pending migrations from src/db/migrations. */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = createPool(connectionString, 1);
  try {
    await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
