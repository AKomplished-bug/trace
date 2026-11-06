import { and, eq, isNull } from "drizzle-orm";
import { createDb, createPool } from "../src/db/client";
import { cards } from "../src/db/schema";
import { SEED } from "../src/db/seed";
import { IncreaseAdapter } from "../src/integrations/increase";
import { databaseConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";

/**
 * Links the seeded card to a new Increase sandbox card: creates and funds a sandbox account,
 * creates a virtual card, and stores its id (and real last4) on the seeded card. Idempotent: a
 * card that is already linked is left alone. Needs DATABASE_URL and INCREASE_API_KEY only; the
 * key is never logged. Run after db:migrate and db:seed.
 */
const SANDBOX_FUNDING_CENTS = 10_000_000; // $100,000 float at Increase so authorizations aren't declined.

const apiKey = process.env.INCREASE_API_KEY;
if (!apiKey) {
  logger.error("Invalid environment: INCREASE_API_KEY is required");
  process.exit(1);
}
const pool = createPool(databaseConfig().DATABASE_URL, 1);
try {
  const db = createDb(pool);
  const [card] = await db.select({ providerId: cards.providerId }).from(cards).where(eq(cards.id, SEED.cardId));
  if (!card) throw new Error("Seeded card not found; run npm run db:seed first");
  if (card.providerId) {
    logger.info({ card_id: SEED.cardId, provider_card_id: card.providerId, outcome: "already_linked" }, "card already linked to Increase; nothing to do");
  } else {
    // webhookSecret is unused here: the script never receives webhooks.
    const increase = new IncreaseAdapter({ apiKey, webhookSecret: "unused" });
    const created = await increase.bootstrapSandboxCard({ name: "Trace demo", fundingCents: SANDBOX_FUNDING_CENTS });
    const linked = await db
      .update(cards)
      .set({ providerId: created.cardId, last4: created.last4 })
      .where(and(eq(cards.id, SEED.cardId), isNull(cards.providerId)))
      .returning({ id: cards.id });
    logger.info(
      { card_id: SEED.cardId, provider_account_id: created.accountId, provider_card_id: created.cardId, outcome: linked.length ? "linked" : "lost_race" },
      linked.length ? "seeded card linked to a new Increase sandbox card" : "card was linked concurrently; the new sandbox card is unused",
    );
  }
} catch (error) {
  const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
  logger.error({ err: safeErrorForLog(error), provider_request_id: requestId }, "Increase bootstrap failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
