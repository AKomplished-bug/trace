import { NextResponse, type NextRequest } from "next/server";
import { sessionConfig } from "./lib/config";
import { SESSION_COOKIE, verifySession } from "./lib/session";
import { errorResponse } from "./app/api/responses";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}


/**
 * Coarse gate in front of every route, from the signed cookie alone (no database):
 * - `/api/ops/**` needs an OPS session (401 / 403 JSON).
 * - Other API routes check the session themselves (webhooks and login are public).
 * - Pages other than /login need a session (redirect to /login); `/ops/**` pages need OPS.
 * Handlers still call requireOwner / requireOps first; pages call requirePageSession.
 */
export function proxy(request: NextRequest): Response {
  const { pathname } = request.nextUrl;
  const claims = verifySession(request.cookies.get(SESSION_COOKIE)?.value, sessionConfig().SESSION_SECRET);

  if (isUnder(pathname, "/api")) {
    if (!isUnder(pathname, "/api/ops")) return NextResponse.next();
    if (!claims) return errorResponse(401, "unauthenticated", "Sign in to continue");
    if (claims.role !== "OPS") return errorResponse(403, "forbidden", "This needs an Ops session");
    return NextResponse.next();
  }

  if (pathname === "/login") return NextResponse.next();
  if (!claims) return NextResponse.redirect(new URL("/login", request.url));
  if (isUnder(pathname, "/ops") && claims.role !== "OPS") return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
