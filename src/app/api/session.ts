import { SEED } from "../../db/seed";

/**
 * Auth contract for owner routes: call it FIRST, before validating input, and return the
 * Response if you get one (401 not signed in, 403 not an owner). Pre-auth for now: always the
 * seeded owner and account; the session work replaces this body only.
 */
export async function requireOwner(request: Request): Promise<{ userId: string; accountId: string } | Response> {
  void request;
  return { userId: SEED.ownerUserId, accountId: SEED.accountId };
}
