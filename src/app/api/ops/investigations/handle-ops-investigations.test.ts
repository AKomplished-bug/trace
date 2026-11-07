import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, investigations, ledgerEntries, reconciliationRecords, reconciliationRuns, transactionEvents, transactions } from "../../../../db/schema";
import { SEED } from "../../../../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../../../../db/test-helpers";
import { sessionConfig } from "../../../../lib/config";
import { newId } from "../../../../lib/ids";
import { logger } from "../../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../../lib/session";
import { DEMO, demoReconciliationSource, seedDemoStory } from "../../../../services/demo";
import { claimNextRun, executeRun, requestRun } from "../../../../services/reconciliation";
import { getReconciliationOverview } from "../../../../services/reconciliation-queries";
import { getTransactionDetail } from "../../../../services/transaction-queries";
import { handleAddNote, handleGetInvestigation, handleListInvestigations, handleOpenInvestigation, handleResolveInvestigation } from "./handle-ops-investigations";

const { pool, db } = createTestDb();
const deps = { db, logger };
// Stands in for personal data: a payee or merchant name on the transaction.
const PII = "Jane Doe Consulting";

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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, body: await r.json() };
}

const list = (query = "") => json(handleListInvestigations(deps, request(`/api/ops/investigations${query}`)));
const open = (recordId: string) => json(handleOpenInvestigation(deps, request("/api/ops/investigations", "POST", { recordId })));
const detail = (id: string) => json(handleGetInvestigation(deps, request(`/api/ops/investigations/${id}`), { id }));
const note = (id: string, body: unknown) => json(handleAddNote(deps, request(`/api/ops/investigations/${id}/notes`, "POST", body), { id }));
const resolve = (id: string, body: unknown) => json(handleResolveInvestigation(deps, request(`/api/ops/investigations/${id}/resolve`, "POST", body), { id }));

/** Reconciles the demo story (provider "demo" via the fakes); returns the run's records. */
async function reconcile() {
  await requestRun(db, { provider: "demo", window: { start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000) }, userId: SEED.opsUserId, correlationId: newId() });
  const claimed = await claimNextRun(db, { leaseSeconds: 60, providers: ["demo"] });
  await executeRun(db, claimed!, { demo: await demoReconciliationSource(db) }, logger);
  return db.select().from(reconciliationRecords).where(eq(reconciliationRecords.runId, claimed!.id));
}

async function demoMismatch() {
  await seedDemoStory(db, logger);
  await db.update(transactions).set({ counterparty: PII }).where(eq(transactions.id, DEMO.purchaseTransactionId));
  const records = await reconcile();
  return { mismatch: records.find((r) => r.status === "AMOUNT_MISMATCH")!, matched: records.find((r) => r.status === "MATCHED")! };
}

beforeEach(async () => {
  await resetDb(db);
  signIn("OPS");
});
afterAll(() => pool.end());

describe("Ops investigations API", () => {
  it("is OPS only on every route", async () => {
    const id = newId();
    for (const role of [null, "OWNER"] as const) {
      signIn(role);
      const status = role ? 403 : 401;
      expect((await list()).status).toBe(status);
      expect((await open(id)).status).toBe(status);
      expect((await detail(id)).status).toBe(status);
      expect((await note(id, { body: "x" })).status).toBe(status);
      expect((await resolve(id, { note: "x", adjustmentCents: -1500 })).status).toBe(status);
    }
    expect(await db.select().from(investigations)).toHaveLength(0);
  });

  it("refuses Ops POSTs from another origin", async () => {
    const { mismatch } = await demoMismatch();
    const crossSite = (path: string, body: unknown) => {
      const r = request(path, "POST", body);
      r.headers.set("origin", "https://evil.example");
      return r;
    };
    const id = newId();
    expect(await json(handleOpenInvestigation(deps, crossSite("/api/ops/investigations", { recordId: mismatch.id })))).toMatchObject({ status: 403, body: { error: { code: "cross_origin" } } });
    expect((await json(handleAddNote(deps, crossSite(`/api/ops/investigations/${id}/notes`, { body: "x" }), { id }))).status).toBe(403);
    expect((await json(handleResolveInvestigation(deps, crossSite(`/api/ops/investigations/${id}/resolve`, { note: "x", adjustmentCents: -1500 }), { id }))).status).toBe(403);
    expect(await db.select().from(investigations)).toHaveLength(0);
    expect(await db.select().from(transactions).where(eq(transactions.type, "ADJUSTMENT"))).toHaveLength(0);
  });

  it("opens one investigation per exception, refuses matched records", async () => {
    const { mismatch, matched } = await demoMismatch();
    const first = await open(mismatch.id);
    expect(first).toMatchObject({ status: 201, body: { created: true, investigation: { status: "OPEN" } } });
    const again = await open(mismatch.id);
    expect(again).toMatchObject({ status: 200, body: { created: false, investigation: { id: first.body.investigation.id } } });
    expect(await open(matched.id)).toMatchObject({ status: 409, body: { error: { code: "not_an_exception" } } });
    expect((await open(newId())).status).toBe(404);
    expect((await list("?status=OPEN")).body.items).toHaveLength(1);
    expect((await list("?status=RESOLVED")).body.items).toHaveLength(0);
    const overview = await getReconciliationOverview(db, {});
    expect(overview.exceptions[0].investigationId).toBe(first.body.investigation.id);
  });

  it("shows the record, trace, replay, notes and audit trail, without payloads or personal data", async () => {
    const { mismatch } = await demoMismatch();
    const { body: opened } = await open(mismatch.id);
    const id = opened.investigation.id;
    expect((await note(id, { body: "Provider says $80; merchant receipt says $65." })).status).toBe(201);
    expect(await note(id, { body: "  " })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("body is required") } } });

    const response = await handleGetInvestigation(deps, request(`/api/ops/investigations/${id}`), { id });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(PII);
    expect(text).not.toContain("payload");
    const body = JSON.parse(text);
    expect(body.record).toMatchObject({ status: "AMOUNT_MISMATCH", internalAmountCents: 6500, externalAmountCents: 8000, differenceCents: 1500, provider: "demo" });
    expect(body.trace.transaction).toMatchObject({ id: DEMO.purchaseTransactionId, type: "CARD_PURCHASE", status: "SETTLED" });
    expect(body.trace.steps.map((s: { kind: string }) => s.kind)).toEqual(["HOLD_CREATED", "LEDGER_POSTED", "HOLD_RELEASED", "STATUS_CHANGED"]);
    expect(body.trace.replay.consistent).toBe(true);
    expect(body.notes.map((n: { body: string }) => n.body)).toEqual(["Provider says $80; merchant receipt says $65."]);
    expect(body.audit.map((a: { action: string }) => a.action)).toEqual(["investigation.open", "investigation.note"]);
    expect((await detail(newId())).status).toBe(404);
  });

  it("resolves with an ADJUSTMENT posted exactly once, even when submitted twice at once", async () => {
    const { mismatch } = await demoMismatch();
    const { body: opened } = await open(mismatch.id);
    const id = opened.investigation.id;
    const before = await balances(db);

    const submit = { note: "Merchant captured $80; post the $15 difference.", adjustmentCents: -1500 };
    const results = await Promise.all([resolve(id, submit), resolve(id, submit)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("already_resolved");
    expect(await resolve(id, submit)).toMatchObject({ status: 409 });

    const adjustments = await db.select().from(transactions).where(eq(transactions.type, "ADJUSTMENT"));
    expect(adjustments).toHaveLength(1);
    const [adjustment] = adjustments;
    expect(adjustment).toMatchObject({ status: "SETTLED", amountCents: 1500, relatedTransactionId: DEMO.purchaseTransactionId, accountId: SEED.accountId, idempotencyKey: `investigation-${id}` });
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, adjustment.id));
    expect(entries.map((e) => [e.entryType, e.amountCents])).toEqual([["ADJUSTMENT", -1500]]);
    const steps = await db.select().from(transactionEvents).where(eq(transactionEvents.transactionId, adjustment.id)).orderBy(transactionEvents.seq);
    expect(steps.map((s) => [s.kind, s.ledgerDeltaCents, s.toStatus])).toEqual([
      ["LEDGER_POSTED", -1500, null],
      ["STATUS_CHANGED", 0, "SETTLED"],
    ]);

    const after = await balances(db);
    expect(after).toEqual({ cachedCents: before.cachedCents - 1500, ledgerSumCents: before.ledgerSumCents - 1500, replayMatches: true });
    expect(after.cachedCents).toBe(after.ledgerSumCents);

    const [resolvedRecord] = await db.select().from(reconciliationRecords).where(eq(reconciliationRecords.id, mismatch.id));
    expect(resolvedRecord.resolvedAt).not.toBeNull();
    expect(resolvedRecord).toMatchObject({ status: "AMOUNT_MISMATCH", internalAmountCents: 6500, externalAmountCents: 8000 });
    expect((await getReconciliationOverview(db, {})).exceptions).toHaveLength(0);

    const { body } = await detail(id);
    expect(body.investigation).toMatchObject({ status: "RESOLVED", adjustmentTransactionId: adjustment.id, resolvedBy: SEED.opsUserId });
    expect(body.adjustment).toMatchObject({ id: adjustment.id, amountCents: 1500 });
    expect(body.notes.at(-1).body).toBe(submit.note);
    const resolveAudit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "investigation.resolve")));
    expect(resolveAudit).toHaveLength(1);
    expect(resolveAudit[0].newState).toEqual({ status: "RESOLVED", adjustmentTransactionId: adjustment.id, adjustmentCents: -1500 });

    // The owner sees the adjustment linked from the purchase, and the purchase from the adjustment.
    const purchase = await getTransactionDetail(db, SEED.accountId, DEMO.purchaseTransactionId);
    expect(purchase!.related).toEqual([expect.objectContaining({ id: adjustment.id, type: "ADJUSTMENT", relation: "follow_up", postedCents: -1500 })]);
    const own = await getTransactionDetail(db, SEED.accountId, adjustment.id);
    expect(own!.related).toEqual([expect.objectContaining({ id: DEMO.purchaseTransactionId, relation: "original" })]);

    // History is untouched: the purchase still posted −$65; the next run matches it with the adjustment.
    const [purchaseEntry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, DEMO.purchaseTransactionId));
    expect(purchaseEntry.amountCents).toBe(-6500);
    const rerun = await reconcile();
    expect(rerun.map((r) => [r.transactionType, r.status, r.internalAmountCents])).toEqual(
      expect.arrayContaining([
        ["CARD_PURCHASE", "MATCHED", 8000],
        ["FUNDING", "MATCHED", 50000],
      ]),
    );
  });

  it("resolves without an adjustment; refuses one when there is no transaction to adjust", async () => {
    const { mismatch } = await demoMismatch();
    const { body: opened } = await open(mismatch.id);
    expect(await resolve(opened.investigation.id, { note: "Provider corrected it on their side." })).toMatchObject({
      status: 200,
      body: { investigation: { status: "RESOLVED", adjustmentTransactionId: null } },
    });
    expect(await db.select().from(transactions).where(eq(transactions.type, "ADJUSTMENT"))).toHaveLength(0);

    const [run] = await db.select({ id: reconciliationRuns.id }).from(reconciliationRuns);
    const [orphan] = await db
      .insert(reconciliationRecords)
      .values({ runId: run.id, status: "MISSING_INTERNAL", transactionType: "CARD_REVERSAL", externalId: "card_refund_x", externalAmountCents: 500, externalStatus: "SETTLED" })
      .returning({ id: reconciliationRecords.id });
    const { body: second } = await open(orphan.id);
    expect(await resolve(second.investigation.id, { note: "Credit it", adjustmentCents: 500 })).toMatchObject({ status: 422, body: { error: { code: "adjustment_not_allowed" } } });
    expect((await detail(second.investigation.id)).body.investigation.status).toBe("OPEN");
  });

  it("allows an adjustment only on an amount mismatch whose transaction has posted", async () => {
    await seedDemoStory(db, logger);
    const records = await reconcile();
    const [run] = await db.select({ id: reconciliationRuns.id }).from(reconciliationRuns);
    // A status mismatch on the funding: the transaction has posted, but amounts agree.
    const [statusRecord] = await db
      .insert(reconciliationRecords)
      .values({ runId: run.id, status: "STATUS_MISMATCH", transactionType: "FUNDING", transactionId: DEMO.fundingTransactionId, accountId: SEED.accountId, internalAmountCents: 50000, externalAmountCents: 50000 })
      .returning({ id: reconciliationRecords.id });
    const { body: statusCase } = await open(statusRecord.id);
    expect(await resolve(statusCase.investigation.id, { note: "x", adjustmentCents: 100 })).toMatchObject({ status: 422, body: { error: { code: "adjustment_not_allowed" } } });

    // An amount mismatch on a transaction that never posted (still authorized).
    const authorized = await createTransaction(db, { type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents: 8000, provider: "demo", providerObjectId: "demo_cp_open" });
    const [unposted] = await db
      .insert(reconciliationRecords)
      .values({ runId: run.id, status: "AMOUNT_MISMATCH", transactionType: "CARD_PURCHASE", transactionId: authorized, accountId: SEED.accountId, internalAmountCents: 8000, externalAmountCents: 7000 })
      .returning({ id: reconciliationRecords.id });
    const { body: unpostedCase } = await open(unposted.id);
    expect(await resolve(unpostedCase.investigation.id, { note: "x", adjustmentCents: 1000 })).toMatchObject({ status: 422, body: { error: { code: "adjustment_not_allowed" } } });

    // The real mismatch: only the amount that closes the gap is accepted.
    const mismatch = records.find((r) => r.status === "AMOUNT_MISMATCH")!;
    const { body: real } = await open(mismatch.id);
    expect(await resolve(real.investigation.id, { note: "x", adjustmentCents: -1000 })).toMatchObject({
      status: 409,
      body: { error: { code: "adjustment_mismatch", message: "The adjustment must be -1500 cents to bring Trace to the provider's amount" } },
    });
    expect(await resolve(real.investigation.id, { note: "x", adjustmentCents: 1500 })).toMatchObject({ status: 409 });
    expect(await db.select().from(transactions).where(eq(transactions.type, "ADJUSTMENT"))).toHaveLength(0);
    expect((await detail(real.investigation.id)).body.investigation.status).toBe("OPEN");
  });

  it("overlapping runs: one open case per transaction, and a second adjustment is refused", async () => {
    await seedDemoStory(db, logger);
    const first = (await reconcile()).find((r) => r.status === "AMOUNT_MISMATCH")!;
    const second = (await reconcile()).find((r) => r.status === "AMOUNT_MISMATCH")!;
    expect(second.id).not.toBe(first.id);

    const { body: opened } = await open(first.id);
    expect(await open(second.id)).toMatchObject({ status: 200, body: { created: false, investigation: { id: opened.investigation.id } } });
    expect((await resolve(opened.investigation.id, { note: "Post the $15", adjustmentCents: -1500 })).status).toBe(200);

    const { status, body: later } = await open(second.id);
    expect(status).toBe(201);
    expect(later.investigation.id).not.toBe(opened.investigation.id);
    expect(await resolve(later.investigation.id, { note: "Again", adjustmentCents: -1500 })).toMatchObject({
      status: 409,
      body: { error: { code: "adjustment_mismatch", message: "Trace already matches the provider's amount; resolve without an adjustment" } },
    });
    expect((await resolve(later.investigation.id, { note: "Already corrected by the first case" })).status).toBe(200);
    expect(await db.select().from(transactions).where(eq(transactions.type, "ADJUSTMENT"))).toHaveLength(1);
    expect((await balances(db)).replayMatches).toBe(true);
  });

  it("validates the resolution", async () => {
    const { mismatch } = await demoMismatch();
    const { body: opened } = await open(mismatch.id);
    const id = opened.investigation.id;
    expect((await resolve(id, { note: "x", adjustmentCents: 0 })).body.error.message).toContain("must not be zero");
    expect((await resolve(id, { note: "x", adjustmentCents: 1.5 })).body.error.message).toContain("whole cents");
    expect((await resolve(id, { adjustmentCents: -1500 })).body.error.message).toContain("note must be text");
    expect((await resolve(id, { note: "x", adjustmentCents: 100_000_001 })).body.error.message).toContain("at most");
    expect((await detail(id)).body.investigation.status).toBe("OPEN");
  });
});
