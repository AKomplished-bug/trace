import { createDb, createPool } from "../src/db/client";
import { seed, SEED } from "../src/db/seed";
import { databaseConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { logger } from "../src/lib/logger";
import { DEMO, demoReconciliationSource, seedDemoStory } from "../src/services/demo";
import { flushCounters } from "../src/services/metrics";
import { claimNextRun, executeRun, requestRun } from "../src/services/reconciliation";

// Dev only: the demo story, then one reconciliation of it against the provider fakes, where Increase
// reports the $65 settlement as $80. Runs in this process (the worker never claims provider "demo"),
// so no provider keys are needed. Re-running adds another run with the same result.
const WINDOW_DAYS = 30;
const pool = createPool(databaseConfig().DATABASE_URL, 1);
try {
  const db = createDb(pool);
  await seed(db);
  await seedDemoStory(db);
  const end = new Date();
  const window = { start: new Date(end.getTime() - WINDOW_DAYS * 86_400_000), end };
  const requested = await requestRun(db, { provider: DEMO.provider, window, userId: SEED.opsUserId, correlationId: newId() });
  const claimed = await claimNextRun(db, { leaseSeconds: 120, providers: [DEMO.provider] });
  if (!claimed) throw new Error(`demo run ${requested.run.id} is already being executed`);
  const outcome = await executeRun(db, claimed, { [DEMO.provider]: await demoReconciliationSource(db) }, logger);
  await flushCounters(db, logger);
  logger.info({ run_id: claimed.id, outcome }, "demo reconciliation finished; open /ops/reconciliation as the Ops user");
  if (outcome !== "succeeded") process.exitCode = 1;
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "demo reconciliation failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
