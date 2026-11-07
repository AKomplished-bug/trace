import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../lib/password";
import { users } from "./schema";
import { seed, SEED, TEST_PASSWORDS } from "./seed";
import { createTestDb, resetDb } from "./test-helpers";

const { pool, db } = createTestDb();

async function ownerHash() {
  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, SEED.ownerUserId));
  return row.hash;
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe("seed passwords", () => {
  it("rotates a seeded user's password when re-seeded with a new one, and keeps it when given none", async () => {
    expect(await verifyPassword(TEST_PASSWORDS.owner, await ownerHash())).toBe(true);
    await seed(db, { owner: await hashPassword("a-rotated-password") });
    expect(await verifyPassword("a-rotated-password", await ownerHash())).toBe(true);
    expect(await verifyPassword(TEST_PASSWORDS.owner, await ownerHash())).toBe(false);
    await seed(db);
    expect(await verifyPassword("a-rotated-password", await ownerHash())).toBe(true);
  });
});
