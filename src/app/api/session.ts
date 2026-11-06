import { SEED } from "../../db/seed";

/**
 * The account the request acts on. Pre-auth for now: always the seeded demo account. The session
 * work replaces this body with the signed-in owner's account; callers don't change.
 */
export async function currentAccountId(request: Request): Promise<string> {
  void request;
  return SEED.accountId;
}
