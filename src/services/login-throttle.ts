import { createHmac } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { loginThrottles } from "../db/schema";

export type ThrottleScope = "email" | "ip";

/** Attempts allowed per key in one window; the attempt that reaches the limit locks the key. */
export const LOGIN_LIMITS: Record<ThrottleScope, number> = { email: 10, ip: 50 };
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_LOCK_SECONDS = 15 * 60;

export interface ThrottleKey {
  scope: ThrottleScope;
  keyHash: string;
}

/** The stored key for an email or IP: an HMAC under the session secret, so the table holds neither. */
export function throttleKey(scope: ThrottleScope, value: string, secret: string): ThrottleKey {
  return { scope, keyHash: createHmac("sha256", secret).update(`login-throttle:${scope}:${value}`).digest("base64url") };
}

function matching(keys: ThrottleKey[]) {
  return or(...keys.map((key) => and(eq(loginThrottles.scope, key.scope), eq(loginThrottles.keyHash, key.keyHash))));
}

/**
 * Counts one login attempt against every key before the password is checked, so concurrent
 * attempts can't all pass a check made before any of them is recorded. Under the keys' row locks
 * (email before ip, the scope order, so two attempts can't deadlock): if any key is locked, nothing
 * is counted and the attempt is throttled; otherwise each key's count goes up (from 1 once its
 * window or lock has passed) and a key that reaches its limit is locked. A success gives its
 * attempt back with `releaseLoginAttempt`. DB clock throughout.
 */
export async function reserveLoginAttempt(db: Db, keys: ThrottleKey[]): Promise<"allowed" | "throttled"> {
  return db.transaction(async (tx) => {
    await tx
      .insert(loginThrottles)
      .values(keys.map((key) => ({ ...key, attempts: 0, windowStartedAt: sql`now()` })))
      // A no-op update, so an existing row is locked here and the pruner (SKIP LOCKED) can't delete it before the select.
      .onConflictDoUpdate({ target: [loginThrottles.scope, loginThrottles.keyHash], set: { attempts: sql`${loginThrottles.attempts}` } });
    const rows = await tx
      .select({
        scope: loginThrottles.scope,
        keyHash: loginThrottles.keyHash,
        locked: sql<boolean>`${loginThrottles.lockedUntil} > now()`,
        fresh: sql<boolean>`coalesce(${loginThrottles.lockedUntil} <= now(), ${loginThrottles.windowStartedAt} <= now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS}))`,
      })
      .from(loginThrottles)
      .where(matching(keys))
      .orderBy(asc(loginThrottles.scope))
      .for("update");
    if (rows.some((row) => row.locked)) return "throttled";
    for (const row of rows) {
      const attempts = row.fresh ? sql`1` : sql`${loginThrottles.attempts} + 1`;
      await tx
        .update(loginThrottles)
        .set({
          attempts,
          windowStartedAt: row.fresh ? sql`now()` : loginThrottles.windowStartedAt,
          lockedUntil: sql`CASE WHEN ${attempts} >= ${LOGIN_LIMITS[row.scope as ThrottleScope]} THEN now() + make_interval(secs => ${LOGIN_LOCK_SECONDS}) END`,
        })
        .where(and(eq(loginThrottles.scope, row.scope), eq(loginThrottles.keyHash, row.keyHash)));
    }
    return "allowed";
  });
}

/** Gives back a successful attempt's count, unlocking a key it had taken to the limit. */
export async function releaseLoginAttempt(db: Db, keys: ThrottleKey[]): Promise<void> {
  for (const key of keys) {
    await db
      .update(loginThrottles)
      .set({
        attempts: sql`greatest(${loginThrottles.attempts} - 1, 0)`,
        lockedUntil: sql`CASE WHEN ${loginThrottles.attempts} - 1 < ${LOGIN_LIMITS[key.scope]} THEN NULL ELSE ${loginThrottles.lockedUntil} END`,
      })
      .where(and(eq(loginThrottles.scope, key.scope), eq(loginThrottles.keyHash, key.keyHash)));
  }
}

/**
 * Deletes up to `limit` rows whose window has passed and that aren't locked: they would restart
 * from 1 on the next attempt anyway. Rows a login holds are skipped. Returns how many it deleted.
 */
export async function pruneLoginThrottles(db: Db, limit: number): Promise<number> {
  const { rowCount } = await db.execute(sql`
    DELETE FROM ${loginThrottles} WHERE (scope, key_hash) IN (
      SELECT scope, key_hash FROM ${loginThrottles}
      WHERE window_started_at < now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS})
        AND (locked_until IS NULL OR locked_until < now())
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)`);
  return rowCount ?? 0;
}
