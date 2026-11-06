import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SEED } from "./db/seed";
import { sessionConfig } from "./lib/config";
import { SESSION_COOKIE, signSession } from "./lib/session";
import { proxy } from "./proxy";

function cookieFor(role: "OWNER" | "OPS", userId: string = role === "OWNER" ? SEED.ownerUserId : SEED.opsUserId) {
  const accountId = role === "OWNER" ? SEED.accountId : null;
  const token = signSession({ userId, role, accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
}

const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

describe("proxy", () => {
  it("blocks /api/ops for owners and signed-out callers, and lets OPS through", async () => {
    const owner = proxy(request("/api/ops/metrics", cookieFor("OWNER")));
    expect(owner.status).toBe(403);
    expect(await owner.json()).toEqual({ error: { code: "forbidden", message: "This needs an Ops session" } });
    expect(proxy(request("/api/ops", cookieFor("OWNER"))).status).toBe(403);
    expect(proxy(request("/api/ops/events")).status).toBe(401);
    expect(passes(proxy(request("/api/ops/metrics", cookieFor("OPS"))))).toBe(true);
  });

  it("rejects a tampered cookie that claims OPS", () => {
    const [, signature] = cookieFor("OWNER").split("=")[1].split(".");
    const forged = Buffer.from(
      JSON.stringify({ userId: SEED.ownerUserId, role: "OPS", accountId: null, expiresAt: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");
    expect(proxy(request("/api/ops/metrics", `${SESSION_COOKIE}=${forged}.${signature}`)).status).toBe(401);
    expect(proxy(request("/ops", `${SESSION_COOKIE}=${forged}.${signature}`)).headers.get("location")).toBe(
      "http://localhost/login",
    );
  });

  it("redirects signed-out page requests to /login and owners away from /ops", () => {
    expect(proxy(request("/")).headers.get("location")).toBe("http://localhost/login");
    expect(proxy(request("/transactions/abc")).headers.get("location")).toBe("http://localhost/login");
    expect(passes(proxy(request("/login")))).toBe(true);
    expect(passes(proxy(request("/", cookieFor("OWNER"))))).toBe(true);
    expect(proxy(request("/ops/events", cookieFor("OWNER"))).headers.get("location")).toBe("http://localhost/");
    expect(passes(proxy(request("/ops", cookieFor("OPS"))))).toBe(true);
  });

  it("leaves other API routes to their handlers (login and webhooks are public)", () => {
    expect(passes(proxy(request("/api/auth/login")))).toBe(true);
    expect(passes(proxy(request("/api/webhooks/stripe")))).toBe(true);
    expect(passes(proxy(request("/api/account")))).toBe(true);
  });
});
