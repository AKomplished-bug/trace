import { describe, expect, it } from "vitest";
import { SEED } from "../../db/seed";
import { sessionConfig } from "../../lib/config";
import { SESSION_COOKIE, signSession, type SessionClaims } from "../../lib/session";
import { requireOps, requireOwner } from "./session";

const expiresAt = () => Math.floor(Date.now() / 1000) + 600;
const owner: SessionClaims = { userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: expiresAt() };
const ops: SessionClaims = { userId: SEED.opsUserId, role: "OPS", accountId: null, expiresAt: expiresAt() };

function request(token?: string) {
  return new Request("http://localhost/api/x", { headers: token ? { cookie: `other=1; ${SESSION_COOKIE}=${token}` } : {} });
}
const sign = (claims: SessionClaims) => signSession(claims, sessionConfig().SESSION_SECRET);

async function error(result: unknown) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  return { status: response.status, body: await response.json() };
}

describe("requireOwner / requireOps", () => {
  it("returns the owner's user and account from the signed cookie", async () => {
    expect(await requireOwner(request(sign(owner)))).toEqual({ userId: SEED.ownerUserId, accountId: SEED.accountId });
    expect(await requireOps(request(sign(ops)))).toEqual({ userId: SEED.opsUserId });
  });

  it("is 401 without a cookie, with a tampered one, or an expired one", async () => {
    const unauthenticated = { status: 401, body: { error: { code: "unauthenticated", message: "Sign in to continue" } } };
    expect(await error(await requireOwner(request()))).toEqual(unauthenticated);
    const [payload, signature] = sign(owner).split(".");
    const otherAccount = Buffer.from(JSON.stringify({ ...owner, accountId: "00000000-0000-4000-8000-0000000000b2" })).toString("base64url");
    expect(await error(await requireOwner(request(`${otherAccount}.${signature}`)))).toEqual(unauthenticated);
    expect(await error(await requireOwner(request(`${payload}.${signature}x`)))).toEqual(unauthenticated);
    expect(await error(await requireOwner(request(sign({ ...owner, expiresAt: 1 }))))).toEqual(unauthenticated);
    expect(await error(await requireOps(request()))).toEqual(unauthenticated);
    // A cookie that isn't valid percent-encoding is a 401, not a 500.
    const malformed = new Request("http://localhost/api/x", { headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` } });
    expect(await error(await requireOwner(malformed))).toEqual(unauthenticated);
  });

  it("is 403 for the wrong role: owners can't use ops routes and ops can't use owner routes", async () => {
    expect(await error(await requireOps(request(sign(owner))))).toEqual({
      status: 403,
      body: { error: { code: "forbidden", message: "This needs an Ops session" } },
    });
    expect((await error(await requireOwner(request(sign(ops))))).status).toBe(403);
  });
});
