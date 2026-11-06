import { sessionConfig } from "../../lib/config";
import { sessionTokenFromCookieHeader, verifySession } from "../../lib/session";
import { errorResponse } from "./responses";

/** The signed-in caller, from the signed session cookie on `request`. */
function claimsFor(request: Request) {
  return verifySession(sessionTokenFromCookieHeader(request.headers.get("cookie")), sessionConfig().SESSION_SECRET);
}

/**
 * Call first in every owner API handler and return the Response if you get one: 401 without a
 * valid session, 403 for OPS. Owner reads and writes use this `accountId` — never an id from
 * the client.
 */
export async function requireOwner(request: Request): Promise<{ userId: string; accountId: string } | Response> {
  const claims = claimsFor(request);
  if (!claims) return errorResponse(401, "unauthenticated", "Sign in to continue");
  if (claims.role !== "OWNER" || !claims.accountId) return errorResponse(403, "forbidden", "This needs a business owner session");
  return { userId: claims.userId, accountId: claims.accountId };
}

/** Same contract for `/api/ops/**` handlers: 401 without a session, 403 unless OPS. */
export async function requireOps(request: Request): Promise<{ userId: string } | Response> {
  const claims = claimsFor(request);
  if (!claims) return errorResponse(401, "unauthenticated", "Sign in to continue");
  if (claims.role !== "OPS") return errorResponse(403, "forbidden", "This needs an Ops session");
  return { userId: claims.userId };
}
