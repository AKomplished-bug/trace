import { runMigrations } from "../src/db/migrate";
import { databaseConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";

try {
  await runMigrations(databaseConfig().DATABASE_URL);
  logger.info("migrations applied");
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "migration failed");
  process.exitCode = 1;
}
