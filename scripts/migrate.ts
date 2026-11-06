import { runMigrations } from "../src/db/migrate";
import { config } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";

try {
  await runMigrations(config().DATABASE_URL);
  logger.info("migrations applied");
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "migration failed");
  process.exitCode = 1;
}
