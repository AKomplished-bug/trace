import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { userRole } from "../db/schema";

export const SESSION_COOKIE = "trace_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const claimsSchema = z.object({
  userId: z.uuid(),
  role: z.enum(userRole.enumValues),
  /** The owner's account, fixed at sign-in; null for OPS. */
  accountId: z.uuid().nullable(),
  /** Unix seconds. */
  expiresAt: z.number().int(),
});

/** What the signed cookie carries; trusted once the signature checks out. */
export type SessionClaims = z.infer<typeof claimsSchema>;

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** `base64url(json).base64url(hmac-sha256)`. */
export function signSession(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

/** The claims if the signature matches and the session hasn't expired; otherwise null. */
export function verifySession(token: string | undefined, secret: string, nowMs = Date.now()): SessionClaims | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = mac(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = claimsSchema.safeParse(decoded);
  if (!claims.success || claims.data.expiresAt * 1000 <= nowMs) return null;
  return claims.data;
}

/** The session token from a `Cookie` request header, if present; undefined if it isn't decodable. */
export function sessionTokenFromCookieHeader(header: string | null): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
