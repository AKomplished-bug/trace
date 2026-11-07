import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { externalEvents, reconciliationRuns, transactions } from "../../../../db/schema";
import { SEED } from "../../../../db/seed";
import { createTestDb, resetDb } from "../../../../db/test-helpers";
import { sessionConfig } from "../../../../lib/config";
import { newId } from "../../../../lib/ids";
import { logger } from "../../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../../lib/session";
import { DEMO, demoReconciliationSource, seedDemoStory } from "../../../../services/demo";
import { claimNextRun, executeRun, requestRun } from "../../../../services/reconciliation";
import { handleGetRun, handleReconciliationOverview, handleRequestRun, handleRetryRun } from "./handle-ops-reconciliation";

const { pool, db } = createTestDb();
const deps = { db, logger };
// Stands in for personal data: in a provider payload and on the transaction.
const PII = "jane.doe@example.com";

let cookie: string | undefined;
function signIn(role: "OWNER" | "OPS" | null) {
  if (!role) {
    cookie = undefined;
    return;
  }
  const userId = role === "OPS" ? SEED.opsUserId : SEED.ownerUserId;
  const accountId = role === "OWNER" ? SEED.accountId : null;
  const token = signSession({ userId, role, accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET);
  cookie = `${SESSION_COOKIE}=${token}`;
}
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
async function json(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, body: await r.json() };
}

const overview = (query = "") => json(handleReconciliationOverview(deps, request(`/api/ops/reconciliation${query}`)));
const run = (body: unknown) => json(handleRequestRun(deps, request("/api/ops/reconciliation/run", "POST", body)));
const detail = (id: string) => json(handleGetRun(deps, request(`/api/ops/reconciliation/${id}`), { id }));
const retry = (id: string) => json(handleRetryRun(deps, request(`/api/ops/reconciliation/${id}/retry`, "POST"), { id }));

/** The demo mismatch, reconciled by the worker path (provider "demo" via the fakes). */
async function reconciledDemo() {
  await seedDemoStory(db, logger);
  await db.update(transactions).set({ counterparty: PII }).where(eq(transactions.id, DEMO.purchaseTransactionId));
  await db.insert(externalEvents).values({ provider: "increase", externalEventId: "evt_pii", eventType: "card_payment.updated", payload: { email: PII }, correlationId: newId() });
  await requestRun(db, { provider: "demo", window: { start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000) }, userId: SEED.opsUserId, correlationId: newId() });
  const claimed = await claimNextRun(db, { leaseSeconds: 60, providers: ["demo"] });
  await executeRun(db, claimed!, { demo: await demoReconciliationSource(db) }, logger);
  return claimed!.id;
}

beforeEach(async () => {
  await resetDb(db);
  signIn("OPS");
});
afterAll(() => pool.end());

describe("Ops reconciliation API", () => {
  it("is OPS only: 401 without a session, 403 for an owner, on every route", async () => {
    const id = newId();
    for (const role of [null, "OWNER"] as const) {
      signIn(role);
      const status = role ? 403 : 401;
      expect((await overview()).status).toBe(status);
      expect((await run({ provider: "stripe" })).status).toBe(status);
      expect((await detail(id)).status).toBe(status);
      expect((await retry(id)).status).toBe(status);
    }
    expect(await db.select().from(reconciliationRuns)).toHaveLength(0);
  });

  it("refuses Ops POSTs from another origin", async () => {
    const id = newId();
    const crossSite = (path: string, body?: unknown) => {
      const r = request(path, "POST", body);
      r.headers.set("origin", "https://evil.example");
      return r;
    };
    expect(await json(handleRequestRun(deps, crossSite("/api/ops/reconciliation/run", { provider: "stripe" })))).toMatchObject({ status: 403, body: { error: { code: "cross_origin" } } });
    expect((await json(handleRetryRun(deps, crossSite(`/api/ops/reconciliation/${id}/retry`), { id }))).status).toBe(403);
    expect(await db.select().from(reconciliationRuns)).toHaveLength(0);
    const sameSite = request("/api/ops/reconciliation/run", "POST", { provider: "stripe" });
    sameSite.headers.set("origin", "http://localhost");
    expect((await json(handleRequestRun(deps, sameSite))).status).toBe(201);
  });

  it("requests a run: 201 when created, 200 with the same run while it is active", async () => {
    const first = await run({ provider: "increase" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, run: { provider: "increase", status: "PENDING" } });
    const windowDays = (Date.parse(first.body.run.windowEnd) - Date.parse(first.body.run.windowStart)) / 86_400_000;
    expect(windowDays).toBe(7);
    const second = await run({ provider: "increase", windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-11-02T00:00:00Z" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, run: { id: first.body.run.id } });
  });

  it("validates the body", async () => {
    expect(await run({ provider: "demo" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: expect.stringContaining("provider must be one of stripe, increase") } } });
    expect((await run({ provider: "stripe", windowStart: "2026-11-02T00:00:00Z", windowEnd: "2026-11-01T00:00:00Z" })).body.error.message).toContain("windowEnd must be after windowStart");
    expect((await run({ provider: "stripe", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-11-01T00:00:00Z" })).body.error.message).toContain("at most 31 days");
    expect((await run({ provider: "stripe", windowEnd: "yesterday" })).body.error.message).toContain("windowEnd must be an ISO 8601 date-time");
    expect(await run("{not json")).toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
    expect((await detail("nope")).status).toBe(400);
  });

  it("lists runs and the open exceptions queue, filterable by status", async () => {
    const runId = await reconciledDemo();
    const { status, body } = await overview();
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ id: runId, status: "SUCCEEDED", matchedCount: 1, exceptionCount: 1 });
    expect(body.counts).toMatchObject({ MATCHED: 1, AMOUNT_MISMATCH: 1, MISSING_EXTERNAL: 0 });
    expect(body.exceptions).toHaveLength(1);
    expect(body.exceptions[0]).toMatchObject({
      status: "AMOUNT_MISMATCH",
      provider: "demo",
      businessName: "Acme Inc.",
      transactionId: DEMO.purchaseTransactionId,
      internalAmountCents: 6500,
      externalAmountCents: 8000,
      differenceCents: 1500,
      investigationId: null,
    });
    expect((await overview("?status=MATCHED")).body.exceptions).toHaveLength(1);
    expect((await overview("?status=DUPLICATE")).body.exceptions).toHaveLength(0);
    expect((await overview("?status=BOGUS")).status).toBe(400);
  });

  it("shows a run's records side by side, without payloads or personal data", async () => {
    const runId = await reconciledDemo();
    const response = await handleGetRun(deps, request(`/api/ops/reconciliation/${runId}`), { id: runId });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(PII);
    expect(text).not.toContain("payload");
    const body = JSON.parse(text);
    expect(body.records.map((r: { status: string }) => r.status).sort()).toEqual(["AMOUNT_MISMATCH", "MATCHED"]);
    expect(body.audit.map((a: { action: string }) => a.action)).toEqual(["reconciliation.run"]);
    const overviewText = await (await handleReconciliationOverview(deps, request("/api/ops/reconciliation"))).text();
    expect(overviewText).not.toContain(PII);
    expect((await detail(newId())).status).toBe(404);
  });

  it("retries only FAILED runs", async () => {
    const created = await run({ provider: "stripe" });
    const id = created.body.run.id;
    expect(await retry(id)).toMatchObject({ status: 409, body: { error: { code: "run_not_retryable" } } });
    await db.update(reconciliationRuns).set({ status: "FAILED" }).where(eq(reconciliationRuns.id, id));
    expect(await retry(id)).toMatchObject({ status: 200, body: { run: { id, status: "PENDING", attempts: 0 } } });
    expect(await retry(id)).toMatchObject({ status: 409, body: { error: { code: "run_not_retryable" } } });
    expect((await retry(newId())).status).toBe(404);
  });
});
