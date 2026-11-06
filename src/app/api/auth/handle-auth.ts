import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionConfig } from "../../../lib/config";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../../../lib/session";
import { findSessionUser } from "../../../services/users";
import { HOME_FOR_ROLE } from "../../_lib/auth-routes";
import { invalidRequest, withRequestLog, type HandlerDeps } from "../handler";
import { errorResponse } from "../responses";

const bodySchema = z.object({ userId: z.uuid("must be a user id") });

/** HttpOnly so scripts can't read it, Lax so other sites can't post with it, Secure in production. */
function cookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: maxAgeSeconds };
}

type BodyKind = "json" | "form";

/**
 * Login CSRF guard. Only JSON or a urlencoded form (the no-JS buttons) is accepted, and a request
 * whose Origin is present must come from this host. SameSite=Lax doesn't cover sign-in itself:
 * without this, another site could post a form that signs the visitor in as someone else.
 */
function checkPost(request: Request): BodyKind | Response {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" or garbage: treated as cross-origin below.
    }
    if (originHost !== host) return errorResponse(403, "cross_origin", "This request must come from the Trace app");
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") return "json";
  if (type === "application/x-www-form-urlencoded") return "form";
  return errorResponse(415, "unsupported_media_type", "Send application/json or a form (application/x-www-form-urlencoded)");
}

/**
 * POST /api/auth/login — demo sign-in, no password (sandbox). JSON `{ userId }` answers with the
 * user; a form post from /login redirects to the user's home. Sets the signed session cookie.
 */
export async function handleLogin(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/auth/login", async ({ annotate }) => {
    const kind = checkPost(request);
    if (kind instanceof Response) return kind;
    const form = kind === "form";
    let raw: unknown;
    try {
      raw = form ? Object.fromEntries(await request.formData()) : await request.json();
    } catch {
      return errorResponse(400, "invalid_json", form ? "Request body must be a form" : "Request body must be JSON");
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) return invalidRequest(body.error);
    const user = await findSessionUser(deps.db, body.data.userId);
    if (!user) return errorResponse(404, "user_not_found", "No demo user with that id");
    if (user.role === "OWNER" && !user.accountId) return errorResponse(409, "account_not_found", "This business has no account yet");

    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const token = signSession({ userId: user.id, role: user.role, accountId: user.accountId, expiresAt }, sessionConfig().SESSION_SECRET);
    const response = form
      ? NextResponse.redirect(new URL(HOME_FOR_ROLE[user.role], request.url), 303)
      : NextResponse.json({ user: { id: user.id, name: user.name, role: user.role, businessName: user.businessName } });
    response.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_SECONDS));
    annotate({ user_id: user.id, role: user.role, account_id: user.accountId ?? undefined });
    return response;
  });
}

/** POST /api/auth/logout — clears the cookie (same CSRF guard); a form post is redirected to /login. */
export async function handleLogout(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/auth/logout", async () => {
    const kind = checkPost(request);
    if (kind instanceof Response) return kind;
    const response = kind === "form" ? NextResponse.redirect(new URL("/login", request.url), 303) : NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    return response;
  });
}
