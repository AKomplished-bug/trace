import { createDb, createPool } from "../src/db/client";
import { seed, SEED } from "../src/db/seed";
import { databaseConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";

const pool = createPool(databaseConfig().DATABASE_URL, 1);
try {
  await seed(createDb(pool));
  logger.info({ business_id: SEED.businessId, account_id: SEED.accountId }, "seed applied");
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "seed failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
