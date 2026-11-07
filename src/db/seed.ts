import { eq } from "drizzle-orm";
import { hashPassword } from "../lib/password";
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

// Dev and test sign-in only (db:seed:demo, tests). Real environments set TRACE_*_PASSWORD.
export const TEST_PASSWORDS = { owner: "owner-test-password", ops: "ops-test-password" } as const;

/** Password hashes (lib/password.ts) for the seeded users; a missing one leaves that user's as it is. */
export interface SeedPasswordHashes {
  owner?: string;
  ops?: string;
}

/** Hashes of TEST_PASSWORDS. Refuses in production, so a demo seed can't set known passwords there. */
export async function testPasswordHashes(): Promise<SeedPasswordHashes> {
  if (process.env.NODE_ENV === "production") throw new Error("Test passwords are for development only; refusing to use them with NODE_ENV=production");
  return { owner: await hashPassword(TEST_PASSWORDS.owner), ops: await hashPassword(TEST_PASSWORDS.ops) };
}

/**
 * Demo tenant: Acme Inc. with an owner, an ops user, a $0 USD account and one virtual card. Each
 * given password hash replaces the user's current one, so re-seeding with new passwords rotates them.
 */
export async function seed(db: Db, passwordHashes: SeedPasswordHashes = {}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(businesses).values({ id: SEED.businessId, name: "Acme Inc." }).onConflictDoNothing();
    await tx
      .insert(users)
      .values([
        { id: SEED.ownerUserId, businessId: SEED.businessId, email: "owner@acme.test", name: "Alex Owner", role: "OWNER" },
        { id: SEED.opsUserId, businessId: null, email: "ops@trace.test", name: "Sam Ops", role: "OPS" },
      ])
      .onConflictDoNothing();
    if (passwordHashes.owner) await tx.update(users).set({ passwordHash: passwordHashes.owner }).where(eq(users.id, SEED.ownerUserId));
    if (passwordHashes.ops) await tx.update(users).set({ passwordHash: passwordHashes.ops }).where(eq(users.id, SEED.opsUserId));
    await tx.insert(accounts).values({ id: SEED.accountId, businessId: SEED.businessId }).onConflictDoNothing();
    await tx.insert(cards).values({ id: SEED.cardId, accountId: SEED.accountId, last4: "4821" }).onConflictDoNothing();
  });
}
