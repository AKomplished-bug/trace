import type { Db } from "./client";
import { accounts, businesses, cards, users } from "./schema";

// Fixed ids so re-running the seed is a no-op (ON CONFLICT DO NOTHING) and demo links are stable.
export const SEED = {
  businessId: "00000000-0000-4000-8000-000000000001",
  ownerUserId: "00000000-0000-4000-8000-000000000011",
  opsUserId: "00000000-0000-4000-8000-000000000012",
  accountId: "00000000-0000-4000-8000-000000000021",
  cardId: "00000000-0000-4000-8000-000000000031",
} as const;

/** Demo tenant: Acme Inc. with an owner, an ops user, a $0 USD account and one virtual card. */
export async function seed(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(businesses).values({ id: SEED.businessId, name: "Acme Inc." }).onConflictDoNothing();
    await tx
      .insert(users)
      .values([
        { id: SEED.ownerUserId, businessId: SEED.businessId, email: "owner@acme.test", name: "Alex Owner", role: "OWNER" },
        { id: SEED.opsUserId, businessId: null, email: "ops@trace.test", name: "Sam Ops", role: "OPS" },
      ])
      .onConflictDoNothing();
    await tx.insert(accounts).values({ id: SEED.accountId, businessId: SEED.businessId }).onConflictDoNothing();
    await tx.insert(cards).values({ id: SEED.cardId, accountId: SEED.accountId, last4: "4821" }).onConflictDoNothing();
  });
}
