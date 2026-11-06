import { describe, expect, it } from "vitest";
import { sessionTokenFromCookieHeader, signSession, verifySession, type SessionClaims } from "./session";

const secret = "s".repeat(32);
const now = Date.UTC(2026, 10, 7, 12, 0, 0);
const claims: SessionClaims = {
  userId: "00000000-0000-4000-8000-000000000011",
  role: "OWNER",
  accountId: "00000000-0000-4000-8000-000000000021",
  expiresAt: now / 1000 + 3600,
};

describe("session cookie", () => {
  it("round-trips signed claims", () => {
    expect(verifySession(signSession(claims, secret), secret, now)).toEqual(claims);
  });

  it("rejects a tampered payload, even one that upgrades the role", () => {
    const [, signature] = signSession(claims, secret).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "OPS" })).toString("base64url");
    expect(verifySession(`${forged}.${signature}`, secret, now)).toBeNull();
  });

  it("rejects a tampered signature, another secret, and malformed tokens", () => {
    const token = signSession(claims, secret);
    expect(verifySession(`${token.slice(0, -2)}xx`, secret, now)).toBeNull();
    expect(verifySession(token, "t".repeat(32), now)).toBeNull();
    for (const bad of [undefined, "", "abc", "a.b.c", `${token}.extra`, ".sig"]) {
      expect(verifySession(bad, secret, now)).toBeNull();
    }
  });

  it("rejects an expired session and claims with the wrong shape", () => {
    expect(verifySession(signSession({ ...claims, expiresAt: now / 1000 }, secret), secret, now)).toBeNull();
    const wrongShape = signSession({ ...claims, role: "ADMIN" } as unknown as SessionClaims, secret);
    expect(verifySession(wrongShape, secret, now)).toBeNull();
  });

  it("reads the token from a Cookie header", () => {
    expect(sessionTokenFromCookieHeader("a=1; trace_session=abc.def; b=2")).toBe("abc.def");
    expect(sessionTokenFromCookieHeader("trace_session_x=1")).toBeUndefined();
    expect(sessionTokenFromCookieHeader(null)).toBeUndefined();
    expect(sessionTokenFromCookieHeader("trace_session=%E0%A4%A")).toBeUndefined();
  });
});
