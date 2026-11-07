import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loginThrottles } from "../db/schema";
import { createTestDb, resetDb } from "../db/test-helpers";
import { pruneLoginThrottles } from "./login-throttle";

const { pool, db } = createTestDb();

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

async function keys(): Promise<string[]> {
  return (await db.select({ keyHash: loginThrottles.keyHash }).from(loginThrottles)).map((row) => row.keyHash).sort();
}

describe("pruneLoginThrottles", () => {
  it("deletes rows whose window has passed and that aren't locked, in batches", async () => {
    const row = (keyHash: string, windowAgo: string, lockedUntil: string | null) => ({
      scope: "email",
      keyHash,
      attempts: 3,
      windowStartedAt: sql`now() - ${windowAgo}::interval`,
      lockedUntil: lockedUntil === null ? null : sql`now() + ${lockedUntil}::interval`,
    });
    await db.insert(loginThrottles).values([
      row("stale-1", "16 minutes", null),
      row("stale-2", "1 hour", null),
      row("lock-expired", "40 minutes", "-1 minute"),
      row("in-window", "5 minutes", null),
      row("locked", "20 minutes", "5 minutes"),
    ]);
    expect(await pruneLoginThrottles(db, 2)).toBe(2);
    expect(await pruneLoginThrottles(db, 2)).toBe(1);
    expect(await pruneLoginThrottles(db, 2)).toBe(0);
    expect(await keys()).toEqual(["in-window", "locked"]);
  });
});
