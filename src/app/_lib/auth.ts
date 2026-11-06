import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionConfig } from "../../lib/config";
import { SESSION_COOKIE, verifySession } from "../../lib/session";
import { findSessionUser, type Role, type SessionUser } from "../../services/users";
import { apiDeps } from "../api/deps";
import { HOME_FOR_ROLE } from "./auth-routes";

/** An owner's session: always scoped to one business and its account. */
export type OwnerSession = SessionUser & { role: "OWNER"; businessId: string; accountId: string };


/**
 * For pages (server components): the signed-in user, with the names the shell shows. Signed-out
 * or unknown users go to /login, the other role to its own home. API handlers use
 * requireOwner / requireOps (src/app/api/session.ts) instead.
 */
export async function requirePageSession(role: "OWNER"): Promise<OwnerSession>;
export async function requirePageSession(role: "OPS"): Promise<SessionUser>;
export async function requirePageSession(role: Role): Promise<SessionUser> {
  const claims = verifySession((await cookies()).get(SESSION_COOKIE)?.value, sessionConfig().SESSION_SECRET);
  if (!claims) redirect("/login");
  if (claims.role !== role) redirect(HOME_FOR_ROLE[claims.role]);
  const user = await findSessionUser(apiDeps().db, claims.userId);
  if (!user || user.role !== role || (role === "OWNER" && user.accountId !== claims.accountId)) redirect("/login");
  return user;
}
