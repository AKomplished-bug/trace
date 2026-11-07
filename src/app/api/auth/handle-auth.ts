import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionConfig } from "../../../lib/config";
import { safeErrorForLog } from "../../../lib/errors";
import { verifyPassword } from "../../../lib/password";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../../../lib/session";
import { releaseLoginAttempt, reserveLoginAttempt, throttleKey } from "../../../services/login-throttle";
import { countOutcome } from "../../../services/metrics";
import { findLoginUser } from "../../../services/users";
import { HOME_FOR_ROLE } from "../../_lib/auth-routes";
import { checkSameOrigin, invalidRequest, withRequestLog, type HandlerDeps } from "../handler";
import { errorResponse } from "../responses";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().max(254, "must be at most 254 characters").pipe(z.email("must be an email address")),
  password: z.string().min(1, "is required").max(1024, "must be at most 1024 characters"),
});

type LoginOutcome =
  | "success"
  | "invalid_request"
  | "unknown_user"
  | "no_password"
  | "wrong_password"
  | "no_account"
  | "throttled"
  | "throttle_unavailable"
  | "error";

// The one answer for every failed sign-in, so it doesn't say which accounts exist.
const INVALID_CREDENTIALS = ["invalid_credentials", "Email or password is incorrect"] as const;
const THROTTLED = ["too_many_attempts", "Too many sign-in attempts; try again later"] as const;

/**
 * The client IP behind CloudFront: `CloudFront-Viewer-Address` (`ip:port`), which CloudFront sets
 * itself and the ALB only accepts traffic from CloudFront. Null when absent (local dev) or not an IP.
 */
export function viewerIp(request: Request): string | null {
  const address = request.headers.get("cloudfront-viewer-address");
  const ip = address?.slice(0, address.lastIndexOf(":"));
  return ip && isIP(ip) ? ip : null;
}

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
  const crossOrigin = checkSameOrigin(request);
  if (crossOrigin) return crossOrigin;
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") return "json";
  if (type === "application/x-www-form-urlencoded") return "form";
  return errorResponse(415, "unsupported_media_type", "Send application/json or a form (application/x-www-form-urlencoded)");
}

/**
 * POST /api/auth/login — `{ email, password }`. JSON answers with the user; a form post from /login
 * redirects to the user's home, or back to /login with `?error=` on failure. Every failure is the
 * same 401 `invalid_credentials`; throttled attempts are 429 (services/login-throttle.ts). Sets the
 * signed session cookie on success only. Never logs the email or password.
 */
export async function handleLogin(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/auth/login", async ({ log, annotate }) => {
    let outcome: LoginOutcome = "error";
    try {
      const kind = checkPost(request);
      if (kind instanceof Response) {
        outcome = "invalid_request";
        return kind;
      }
      const form = kind === "form";
      let raw: unknown;
      try {
        raw = form ? Object.fromEntries(await request.formData()) : await request.json();
      } catch {
        outcome = "invalid_request";
        return errorResponse(400, "invalid_json", form ? "Request body must be a form" : "Request body must be JSON");
      }
      const body = bodySchema.safeParse(raw);
      if (!body.success) {
        outcome = "invalid_request";
        return invalidRequest(body.error);
      }
      const fail = (status: 401 | 429 | 503, [code, message]: readonly [string, string]) =>
        form ? NextResponse.redirect(new URL(`/login?error=${code}`, request.url), 303) : errorResponse(status, code, message);

      const secret = sessionConfig().SESSION_SECRET;
      const ip = viewerIp(request);
      const keys = [throttleKey("email", body.data.email, secret), ...(ip ? [throttleKey("ip", ip, secret)] : [])];
      // Fail closed: if the attempt can't be counted, it isn't checked.
      let reserved: "allowed" | "throttled";
      try {
        reserved = await reserveLoginAttempt(deps.db, keys);
      } catch (error) {
        log.error({ err: safeErrorForLog(error) }, "login throttle unavailable");
        outcome = "throttle_unavailable";
        return fail(503, ["login_unavailable", "Sign-in is unavailable right now; try again shortly"]);
      }
      if (reserved === "throttled") {
        outcome = "throttled";
        return fail(429, THROTTLED);
      }

      const user = await findLoginUser(deps.db, body.data.email);
      // Unknown users and users without a password still pay for a hash (verifyPassword).
      const valid = await verifyPassword(body.data.password, user?.passwordHash);
      if (!user || !valid) {
        outcome = !user ? "unknown_user" : user.passwordHash ? "wrong_password" : "no_password";
        return fail(401, INVALID_CREDENTIALS);
      }
      if (user.role === "OWNER" && !user.accountId) {
        outcome = "no_account";
        return errorResponse(409, "account_not_found", "This business has no account yet");
      }
      // The attempt succeeded, so it shouldn't count towards a lockout; losing that is harmless.
      await releaseLoginAttempt(deps.db, keys).catch((error: unknown) => {
        log.warn({ user_id: user.id, err: safeErrorForLog(error) }, "login throttle release failed");
      });

      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const token = signSession({ userId: user.id, role: user.role, accountId: user.accountId, expiresAt }, secret);
      const response = form
        ? NextResponse.redirect(new URL(HOME_FOR_ROLE[user.role], request.url), 303)
        : NextResponse.json({ user: { id: user.id, name: user.name, role: user.role, businessName: user.businessName } });
      response.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_SECONDS));
      annotate({ user_id: user.id, role: user.role, account_id: user.accountId ?? undefined });
      outcome = "success";
      return response;
    } finally {
      annotate({ login_outcome: outcome });
      countOutcome("auth_logins_total", { outcome });
    }
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
