import { and, eq, isNull } from "drizzle-orm";
import { createDb, createPool } from "../src/db/client";
import { accounts, cards } from "../src/db/schema";
import { SEED } from "../src/db/seed";
import { IncreaseAdapter } from "../src/integrations/increase";
import { parseIncreaseBootstrapConfig, type IncreaseBootstrapConfig } from "../src/lib/config";
import { safeErrorForLog } from "../src/lib/errors";
import { logger } from "../src/lib/logger";

/**
 * Links the seeded card to a new Increase sandbox card: creates and funds a sandbox account,
 * creates a virtual card, and stores its id (and real last4) on the seeded card. Also stores the
 * card's Increase account on the seeded account, which originates its outbound ACH payments (for
 * a card linked before that, it reads the card's account from Increase). Idempotent: a card and
 * account that are already linked are left alone. The sandbox account is owned by INCREASE_ENTITY_ID
 * if set, else by the only active entity (an anonymous sandbox has no default one; create it by hand,
 * see README). Needs DATABASE_URL and INCREASE_API_KEY; the key is never logged. Run after
 * db:migrate and db:seed.
 */
const SANDBOX_FUNDING_CENTS = 10_000_000; // $100,000 float at Increase so authorizations aren't declined.

let env: IncreaseBootstrapConfig;
try {
  env = parseIncreaseBootstrapConfig(process.env);
} catch (error) {
  logger.error((error as Error).message);
  process.exit(1);
}
const pool = createPool(env.DATABASE_URL, 1);
try {
  const db = createDb(pool);
  const [card] = await db.select({ providerId: cards.providerId }).from(cards).where(eq(cards.id, SEED.cardId));
  if (!card) throw new Error("Seeded card not found; run npm run db:seed first");
  // webhookSecret is unused here: the script never receives webhooks.
  const increase = new IncreaseAdapter({ apiKey: env.INCREASE_API_KEY, webhookSecret: "unused" });
  let providerAccountId: string | undefined;
  if (card.providerId) {
    logger.info({ card_id: SEED.cardId, provider_card_id: card.providerId, outcome: "already_linked" }, "card already linked to Increase");
  } else {
    const { entityId, source } = await increase.resolveEntityId(env.INCREASE_ENTITY_ID);
    logger.info({ provider_entity_id: entityId, source }, "Increase entity for the sandbox account");
    const created = await increase.bootstrapSandboxCard({ name: "Trace demo", fundingCents: SANDBOX_FUNDING_CENTS, entityId });
    const linked = await db
      .update(cards)
      .set({ providerId: created.cardId, last4: created.last4 })
      .where(and(eq(cards.id, SEED.cardId), isNull(cards.providerId)))
      .returning({ id: cards.id });
    logger.info(
      { card_id: SEED.cardId, provider_account_id: created.accountId, provider_card_id: created.cardId, outcome: linked.length ? "linked" : "lost_race" },
      linked.length ? "seeded card linked to a new Increase sandbox card" : "card was linked concurrently; the new sandbox card is unused",
    );
    if (linked.length) providerAccountId = created.accountId;
  }
  const [account] = await db.select({ providerId: accounts.providerId }).from(accounts).where(eq(accounts.id, SEED.accountId));
  if (account?.providerId) {
    logger.info({ account_id: SEED.accountId, provider_account_id: account.providerId, outcome: "already_linked" }, "account already linked to Increase; nothing to do");
  } else {
    const [linkedCard] = await db.select({ providerId: cards.providerId }).from(cards).where(eq(cards.id, SEED.cardId));
    providerAccountId ??= await increase.retrieveCardAccountId(linkedCard.providerId!);
    const linked = await db
      .update(accounts)
      .set({ providerId: providerAccountId })
      .where(and(eq(accounts.id, SEED.accountId), isNull(accounts.providerId)))
      .returning({ id: accounts.id });
    logger.info(
      { account_id: SEED.accountId, provider_account_id: providerAccountId, outcome: linked.length ? "linked" : "lost_race" },
      linked.length ? "seeded account linked to its Increase account for outbound payments" : "account was linked concurrently",
    );
  }
} catch (error) {
  const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
  logger.error({ err: safeErrorForLog(error), provider_request_id: requestId }, "Increase bootstrap failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
