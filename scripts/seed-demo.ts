import { createDb, createPool } from "../src/db/client";
import { seed, SEED, testPasswordHashes } from "../src/db/seed";
import { databaseConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";
import { seedDemoStory } from "../src/services/demo";

// Dev only: the base seed plus the $500 → $80 authorization → $65 settlement story.
const pool = createPool(databaseConfig().DATABASE_URL, 1);
try {
  const db = createDb(pool);
  await seed(db, await testPasswordHashes());
  await seedDemoStory(db);
  logger.info({ business_id: SEED.businessId, account_id: SEED.accountId }, "demo seed applied");
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "demo seed failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
