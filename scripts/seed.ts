import { createDb, createPool } from "../src/db/client";
import { seed, SEED } from "../src/db/seed";
import { parseSeedConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";
import { hashPassword } from "../src/lib/password";

// Both passwords are required in production (parseSeedConfig refuses without them). In dev a missing
// one leaves that user's password as it is: none on a fresh database, so they can't sign in.
const env = parseSeedConfig(process.env);
for (const [name, value] of [["TRACE_OWNER_PASSWORD", env.TRACE_OWNER_PASSWORD], ["TRACE_OPS_PASSWORD", env.TRACE_OPS_PASSWORD]]) {
  if (value === undefined) logger.warn(`${name} is not set: that user's password is left as it is (none on a fresh database)`);
}
const pool = createPool(env.DATABASE_URL, 1);
try {
  await seed(createDb(pool), {
    owner: env.TRACE_OWNER_PASSWORD && (await hashPassword(env.TRACE_OWNER_PASSWORD)),
    ops: env.TRACE_OPS_PASSWORD && (await hashPassword(env.TRACE_OPS_PASSWORD)),
  });
  logger.info({ business_id: SEED.businessId, account_id: SEED.accountId }, "seed applied");
} catch (error) {
  logger.error({ err: safeErrorForLog(error) }, "seed failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
