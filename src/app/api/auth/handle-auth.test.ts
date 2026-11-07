import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../db/client";
import { loginThrottles, users } from "../../../db/schema";
import { SEED, TEST_PASSWORDS } from "../../../db/seed";
import { createTestDb, resetDb } from "../../../db/test-helpers";
import { sessionConfig } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { verifySession } from "../../../lib/session";
import { flushCounters, readCounters } from "../../../services/metrics";
import { handleLogin, handleLogout, viewerIp } from "./handle-auth";

const { pool, db } = createTestDb();
const deps = { db, logger };
const OWNER = { email: "owner@acme.test", password: TEST_PASSWORDS.owner };
const OPS = { email: "ops@trace.test", password: TEST_PASSWORDS.ops };

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function form(body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

const fromIp = (ip: string) => ({ "cloudfront-viewer-address": `${ip}:51234` });

function cookieToken(response: Response): string {
  return decodeURIComponent((response.headers.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="));
}

async function loginCounts() {
  await flushCounters(db, logger);
  return Object.fromEntries((await readCounters(db)).filter((c) => c.name === "auth_logins_total").map((c) => [c.labels.outcome, c.value]));
}

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
});
afterAll(() => pool.end());

describe("POST /api/auth/login", () => {
  it("signs the user in with their email and password: HttpOnly, SameSite=Lax cookie for their account", async () => {
    const response = await handleLogin(deps, json({ ...OWNER, email: "  Owner@Acme.TEST " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: SEED.ownerUserId, name: "Alex Owner", role: "OWNER", businessName: "Acme Inc." } });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
    expect(verifySession(cookieToken(response), sessionConfig().SESSION_SECRET)).toMatchObject({
      userId: SEED.ownerUserId,
      role: "OWNER",
      accountId: SEED.accountId,
    });
  });

  it("redirects a form post to the user's home", async () => {
    const response = await handleLogin(deps, form(OPS));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ops");
    expect(verifySession(cookieToken(response), sessionConfig().SESSION_SECRET)).toMatchObject({ role: "OPS", accountId: null });
  });

  it("answers a wrong password, an unknown email and a user without a password the same way, with no cookie", async () => {
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, SEED.opsUserId));
    const attempts = [{ ...OWNER, password: "not-the-password" }, { email: "nobody@acme.test", password: TEST_PASSWORDS.owner }, OPS];
    for (const attempt of attempts) {
      const response = await handleLogin(deps, json(attempt));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "invalid_credentials", message: "Email or password is incorrect" } });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await loginCounts()).toEqual({ wrong_password: 1, unknown_user: 1, no_password: 1 });
  });

  it("sends a failed form post back to /login with the generic error and no cookie", async () => {
    const response = await handleLogin(deps, form({ ...OWNER, password: "not-the-password" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?error=invalid_credentials");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("validates the body without echoing it", async () => {
    const invalid = await handleLogin(deps, json({ email: "owner-at-acme", password: "" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "invalid_request", message: "email: must be an email address; password: is required" },
    });
    expect(await (await handleLogin(deps, json("{not json"))).json()).toEqual({
      error: { code: "invalid_json", message: "Request body must be JSON" },
    });
  });

  it("never logs the email or the password, and logs the user id on success", async () => {
    const lines: string[] = [];
    const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
    await handleLogin({ db, logger: log }, json(OWNER));
    await handleLogin({ db, logger: log }, json({ ...OWNER, password: "not-the-password" }));
    const output = lines.join("\n");
    expect(output).not.toContain(OWNER.email);
    expect(output).not.toContain(OWNER.password);
    expect(output).not.toContain("not-the-password");
    expect(JSON.parse(lines[0])).toMatchObject({ user_id: SEED.ownerUserId, login_outcome: "success" });
    expect(JSON.parse(lines[1])).toMatchObject({ status: 401, login_outcome: "wrong_password" });
  });

  it("fails closed when an attempt can't be counted, and a failed release doesn't fail the sign-in", async () => {
    const failing = (method: "transaction" | "update") =>
      new Proxy(db, {
        get: (target, key) =>
          key === method
            ? () => {
                throw new Error("db down");
              }
            : Reflect.get(target, key),
      }) as Db;

    const unavailable = await handleLogin({ db: failing("transaction"), logger }, json(OWNER));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: { code: "login_unavailable", message: "Sign-in is unavailable right now; try again shortly" } });
    expect(unavailable.headers.get("set-cookie")).toBeNull();

    const signedIn = await handleLogin({ db: failing("update"), logger }, json(OWNER));
    expect(signedIn.status).toBe(200);
    expect(cookieToken(signedIn)).not.toBe("");
    expect(await loginCounts()).toEqual({ throttle_unavailable: 1, success: 1 });
  });
});

describe("login throttling", () => {
  it("locks an email for 15 minutes after 10 failures, even for the right password, and not other emails", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await handleLogin(deps, json({ ...OWNER, password: `wrong-${i}` }))).status).toBe(401);
    }
    const locked = await handleLogin(deps, json(OWNER));
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: { code: "too_many_attempts", message: "Too many sign-in attempts; try again later" } });
    expect(locked.headers.get("set-cookie")).toBeNull();
    // An unknown email locks the same way, so a lockout doesn't reveal that an account exists.
    for (let i = 0; i < 10; i++) await handleLogin(deps, json({ email: "nobody@acme.test", password: `wrong-${i}` }));
    expect((await handleLogin(deps, json({ email: "nobody@acme.test", password: "x" }))).status).toBe(429);
    expect((await handleLogin(deps, json(OPS))).status).toBe(200);

    await db.update(loginThrottles).set({ lockedUntil: sql`now() - interval '1 second'` });
    expect((await handleLogin(deps, json(OWNER))).status).toBe(200);
    expect(await loginCounts()).toEqual({ wrong_password: 10, unknown_user: 10, throttled: 2, success: 2 });
  });

  it("starts a new count once the window has passed, and a success doesn't count towards a lockout", async () => {
    for (let i = 0; i < 9; i++) await handleLogin(deps, json({ ...OWNER, password: `wrong-${i}` }));
    expect((await handleLogin(deps, json(OWNER))).status).toBe(200);
    expect((await handleLogin(deps, json(OWNER))).status).toBe(200);
    await db.update(loginThrottles).set({ windowStartedAt: sql`now() - interval '16 minutes'` });
    for (let i = 0; i < 9; i++) expect((await handleLogin(deps, json({ ...OWNER, password: `wrong-${i}` }))).status).toBe(401);
    expect((await handleLogin(deps, json(OWNER))).status).toBe(200);
  });

  it("lets exactly 10 of 25 concurrent failures for one email reach the password check", async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => handleLogin(deps, json({ ...OWNER, password: `wrong-${i}` }, fromIp(`198.51.100.${i}`)))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect((await handleLogin(deps, json(OWNER))).status).toBe(429);
  });

  it("caps attempts per client IP across emails, concurrently, without blocking other IPs", async () => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => handleLogin(deps, json({ email: `user${i}@acme.test`, password: "x" }, fromIp("203.0.113.7")))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(50);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    expect((await handleLogin(deps, json(OWNER, fromIp("203.0.113.7")))).status).toBe(429);
    expect((await handleLogin(deps, json(OWNER, fromIp("203.0.113.8")))).status).toBe(200);
    // A throttled attempt counts against no key, so a blocked IP can't use up an account's budget.
    const emailRows = await db.select({ attempts: loginThrottles.attempts }).from(loginThrottles).where(eq(loginThrottles.scope, "email"));
    expect(emailRows.every((row) => row.attempts <= 1)).toBe(true);
  });

  it("stores neither the email nor the IP", async () => {
    await handleLogin(deps, json({ ...OWNER, password: "wrong" }, fromIp("203.0.113.7")));
    const rows = JSON.stringify(await db.select().from(loginThrottles));
    expect(rows).not.toContain("owner@acme.test");
    expect(rows).not.toContain("203.0.113.7");
  });

  it("reads the client IP from CloudFront-Viewer-Address only", () => {
    const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });
    expect(viewerIp(request({ "cloudfront-viewer-address": "203.0.113.7:51234" }))).toBe("203.0.113.7");
    expect(viewerIp(request({ "cloudfront-viewer-address": "2001:db8::1:51234" }))).toBe("2001:db8::1");
    expect(viewerIp(request({ "cloudfront-viewer-address": "not-an-ip:1" }))).toBeNull();
    expect(viewerIp(request({ "x-forwarded-for": "203.0.113.7" }))).toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie", async () => {
    const response = await handleLogout(
      deps,
      new Request("http://localhost/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/trace_session=;.*Max-Age=0/i);
  });
});

describe("login CSRF guard", () => {
  it("rejects a post whose Origin is another site, before signing anyone in", async () => {
    const response = await handleLogin(deps, form(OWNER, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "cross_origin", message: "This request must come from the Trace app" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await handleLogin(deps, form(OWNER, { origin: "null" }))).status).toBe(403);
    expect((await handleLogout(deps, form({}, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("accepts a same-origin post and one without an Origin header", async () => {
    expect((await handleLogin(deps, form(OWNER, { origin: "http://localhost" }))).status).toBe(303);
    expect((await handleLogin(deps, form(OWNER))).status).toBe(303);
  });

  it("accepts only JSON or a urlencoded form", async () => {
    for (const type of ["text/plain", "multipart/form-data; boundary=x", ""]) {
      const response = await handleLogin(
        deps,
        new Request("http://localhost/api/auth/login", { method: "POST", headers: type ? { "content-type": type } : {}, body: "email=x" }),
      );
      expect(response.status, type).toBe(415);
      expect((await response.json()).error.code).toBe("unsupported_media_type");
    }
  });
});
