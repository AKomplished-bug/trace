import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SEED } from "../../../db/seed";
import { createTestDb, resetDb } from "../../../db/test-helpers";
import { sessionConfig } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { verifySession } from "../../../lib/session";
import { handleLogin, handleLogout } from "./handle-auth";

const { pool, db } = createTestDb();
const deps = { db, logger };

function json(body: string) {
  return new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body });
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe("POST /api/auth/login", () => {
  it("sets an HttpOnly, SameSite=Lax cookie signed for the chosen user and their account", async () => {
    const response = await handleLogin(deps, json(JSON.stringify({ userId: SEED.ownerUserId })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: SEED.ownerUserId, name: "Alex Owner", role: "OWNER", businessName: "Acme Inc." } });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
    const token = decodeURIComponent(header.split(";")[0].split("=").slice(1).join("="));
    expect(verifySession(token, sessionConfig().SESSION_SECRET)).toMatchObject({ userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId });
  });

  it("redirects a form post to the user's home", async () => {
    const response = await handleLogin(
      deps,
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ userId: SEED.opsUserId }).toString(),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/ops");
    const token = decodeURIComponent((response.headers.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="));
    expect(verifySession(token, sessionConfig().SESSION_SECRET)).toMatchObject({ role: "OPS", accountId: null });
  });

  it("validates the body and rejects unknown users without leaking internals", async () => {
    const invalid = await handleLogin(deps, json(JSON.stringify({ userId: "nope" })));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid_request", message: "userId: must be a user id" } });
    expect(await (await handleLogin(deps, json("{not json"))).json()).toEqual({
      error: { code: "invalid_json", message: "Request body must be JSON" },
    });
    const unknown = await handleLogin(deps, json(JSON.stringify({ userId: "00000000-0000-4000-8000-0000000000ee" })));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "user_not_found", message: "No demo user with that id" } });
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
  const form = (headers: Record<string, string>) =>
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ userId: SEED.ownerUserId }).toString(),
    });

  it("rejects a post whose Origin is another site, before signing anyone in", async () => {
    const response = await handleLogin(deps, form({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "cross_origin", message: "This request must come from the Trace app" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await handleLogin(deps, form({ origin: "null" }))).status).toBe(403);
    expect((await handleLogout(deps, form({ origin: "https://evil.example" }))).status).toBe(403);
  });

  it("accepts a same-origin post and one without an Origin header", async () => {
    expect((await handleLogin(deps, form({ origin: "http://localhost" }))).status).toBe(303);
    expect((await handleLogin(deps, form({}))).status).toBe(303);
  });

  it("accepts only JSON or a urlencoded form", async () => {
    for (const type of ["text/plain", "multipart/form-data; boundary=x", ""]) {
      const response = await handleLogin(
        deps,
        new Request("http://localhost/api/auth/login", { method: "POST", headers: type ? { "content-type": type } : {}, body: "userId=x" }),
      );
      expect(response.status, type).toBe(415);
      expect((await response.json()).error.code).toBe("unsupported_media_type");
    }
  });
});
