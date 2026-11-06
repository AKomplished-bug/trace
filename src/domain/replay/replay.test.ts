import { describe, expect, it } from "vitest";
import { explainBalance, type HoldKind, type HoldStatus } from "../ledger";
import { accountMismatches, apply, EMPTY_STATE, moneyGraph, pairSettlements, replayAccount, replayTransaction, type ReplayEvent, type TraceKind } from ".";

/**
 * Writes trace rows the way the services do: every state change first (ledger, hold status),
 * then the rows, each recording the account's balances after the change — computed here from
 * the ledger and the holds table model, independently of replay.
 */
class Account {
  ledgerCents = 0;
  holds = new Map<string, { id: string; kind: HoldKind; amountCents: number; status: HoldStatus }>();
  rows: ReplayEvent[] = [];

  available() {
    return explainBalance(this.ledgerCents, [...this.holds.values()]).availableCents;
  }

  private row(transactionId: string, kind: TraceKind, fields: { amountCents?: number; ledgerDeltaCents?: number; toStatus?: string } = {}) {
    const hold = this.holds.get(transactionId);
    this.rows.push({
      id: `row_${this.rows.length + 1}`,
      transactionId,
      accountSeq: this.rows.length + 1,
      kind,
      amountCents: fields.amountCents ?? null,
      ledgerDeltaCents: fields.ledgerDeltaCents ?? 0,
      toStatus: fields.toStatus ?? null,
      hold: hold ? { id: hold.id, kind: hold.kind } : null,
      recorded: { ledgerCents: this.ledgerCents, availableCents: this.available() },
    });
  }

  fund(tx: string, cents: number) {
    this.row(tx, "STATUS_CHANGED", { amountCents: cents, toStatus: "PENDING" });
    this.ledgerCents += cents;
    this.row(tx, "LEDGER_POSTED", { amountCents: cents, ledgerDeltaCents: cents });
    this.row(tx, "STATUS_CHANGED", { amountCents: cents, toStatus: "SETTLED" });
  }

  hold(tx: string, cents: number, kind: HoldKind = "CARD_AUTHORIZATION") {
    this.holds.set(tx, { id: `hold_${tx}`, kind, amountCents: cents, status: "ACTIVE" });
    this.row(tx, "HOLD_CREATED", { amountCents: cents, toStatus: "ACTIVE" });
    if (this.available() < 0) this.row(tx, "HOLD_EXCEEDS_AVAILABLE", { amountCents: cents });
  }

  /** postLedgerEntry({ releaseHoldForTransactionId }) then the status change. */
  settle(tx: string, cents: number, status = "SETTLED") {
    const hold = this.holds.get(tx)!;
    const wasActive = hold.status === "ACTIVE";
    this.ledgerCents -= cents;
    if (wasActive) hold.status = "RELEASED";
    this.row(tx, "LEDGER_POSTED", { amountCents: -cents, ledgerDeltaCents: -cents });
    this.row(tx, wasActive ? "HOLD_RELEASED" : "SETTLED_AFTER_HOLD_CLOSED", { amountCents: hold.amountCents, toStatus: hold.status });
    this.row(tx, "STATUS_CHANGED", { amountCents: cents, toStatus: status });
  }

  /** A debit and its hold release in two separate database transactions (each row records live balances). */
  postThenRelease(tx: string, cents: number) {
    const hold = this.holds.get(tx)!;
    this.ledgerCents -= cents;
    this.row(tx, "LEDGER_POSTED", { amountCents: -cents, ledgerDeltaCents: -cents });
    hold.status = "RELEASED";
    this.row(tx, "HOLD_RELEASED", { amountCents: hold.amountCents, toStatus: "RELEASED" });
  }

  close(tx: string, to: "RELEASED" | "EXPIRED") {
    const hold = this.holds.get(tx)!;
    hold.status = to;
    this.row(tx, to === "EXPIRED" ? "HOLD_EXPIRED" : "HOLD_RELEASED", { amountCents: hold.amountCents, toStatus: to });
    this.row(tx, "STATUS_CHANGED", { amountCents: hold.amountCents, toStatus: to === "EXPIRED" ? "EXPIRED" : "REVERSED" });
  }

  credit(tx: string, cents: number) {
    this.ledgerCents += cents;
    this.row(tx, "LEDGER_POSTED", { amountCents: cents, ledgerDeltaCents: cents });
    this.row(tx, "STATUS_CHANGED", { amountCents: cents, toStatus: "SETTLED" });
  }

  /** An outbound payment sent to the ACH network: a step that moves no money. */
  sentToNetwork(tx: string) {
    this.row(tx, "SUBMITTED_TO_NETWORK");
  }

  /** One transaction's rows, each with the balances of the account's previous row. */
  trace(tx: string): ReplayEvent[] {
    return this.rows
      .filter((row) => row.transactionId === tx)
      .map((row) => ({ ...row, recordedBefore: this.rows[row.accountSeq - 2]?.recorded ?? { ledgerCents: 0, availableCents: 0 } }));
  }

  stored() {
    const active = [...this.holds.values()].filter((h) => h.status === "ACTIVE");
    return { cachedLedgerCents: this.ledgerCents, ledgerSumCents: this.ledgerCents, activeHoldIds: active.map((h) => h.id), availableCents: this.available() };
  }
}

const money = (steps: { after: { ledgerCents: number; availableCents: number } }[]) =>
  steps.map((s) => `${s.after.ledgerCents / 100}/${s.after.availableCents / 100}`);

function expectAccountReplays(account: Account) {
  const result = replayAccount(account.rows);
  expect(result.consistent).toBe(true);
  expect(accountMismatches(result, account.stored())).toEqual([]);
  return result;
}

describe("replay of the spec stories", () => {
  it("$500 → $80 authorization → $65 settlement: 500/500 → 500/420 → 435/435 → 435/435", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.settle("buy", 6500);

    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(result.divergence).toBeNull();
    expect([result.initial.ledgerCents, result.initial.availableCents]).toEqual([50000, 50000]);
    expect(money(result.steps)).toEqual(["500/420", "435/435", "435/435", "435/435"]);
    expect(result.steps.map((s) => s.explanation)).toEqual(["hold_created", "settlement_released_hold", "hold_released_with_settlement", "status_changed"]);
    expect(result.steps.every((s) => s.matches && s.otherActivity === null)).toBe(true);
    expect(result.final.holds["hold_buy"]).toMatchObject({ status: "RELEASED", amountCents: 8000 });
    expect(result.final.statuses).toEqual({ buy: "SETTLED" });

    const all = expectAccountReplays(account);
    expect(money(all.steps)).toEqual(["0/0", "500/500", "500/500", "500/420", "435/435", "435/435", "435/435"]);
  });

  it("expiry: the hold lapses, available is restored, the ledger never moves", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.close("buy", "EXPIRED");
    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/420", "500/500", "500/500"]);
    expect(result.steps[1].explanation).toBe("hold_expired");
    expect(result.final.statuses.buy).toBe("EXPIRED");
    expectAccountReplays(account);
  });

  it("void: the authorization is released before settlement", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.close("buy", "RELEASED");
    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/420", "500/500", "500/500"]);
    expect(result.steps[1].explanation).toBe("hold_released");
    expect(result.final.statuses.buy).toBe("REVERSED");
    expectAccountReplays(account);
  });

  it("late settlement after expiry posts the debit; the closed hold releases nothing twice", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.close("buy", "EXPIRED");
    account.settle("buy", 6500);
    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/420", "500/500", "500/500", "435/435", "435/435", "435/435"]);
    expect(result.steps.map((s) => s.explanation).slice(3)).toEqual(["ledger_posted", "settled_after_hold_closed", "status_changed"]);
    expect(result.final.holds["hold_buy"].status).toBe("EXPIRED");
    expectAccountReplays(account);
  });

  it("refund: a new transaction credits the ledger; the purchase nets to zero", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.settle("buy", 6500);
    account.credit("refund", 6500);
    const refund = replayTransaction(account.trace("refund"));
    expect(refund.consistent).toBe(true);
    expect([refund.initial.ledgerCents, refund.initial.availableCents]).toEqual([43500, 43500]);
    expect(money(refund.steps)).toEqual(["500/500", "500/500"]);
    expect(replayTransaction(account.trace("buy")).consistent).toBe(true);
    expectAccountReplays(account);
  });

  it("over-available authorization: available goes negative and the flag changes nothing", () => {
    const account = new Account();
    account.fund("fund", 5000);
    account.hold("buy", 8000);
    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["50/-30", "50/-30"]);
    expect(result.steps[1].explanation).toBe("hold_exceeds_available");
    expectAccountReplays(account);
  });

  it("payment hold: pending payment reserves funds, completion debits and releases, a return credits back", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("pay", 10000, "PENDING_PAYMENT");
    expect(explainBalance(replayAccount(account.rows).final.ledgerCents, Object.values(replayAccount(account.rows).final.holds))).toMatchObject({
      pendingPaymentsCents: 10000,
      pendingCardHoldsCents: 0,
      availableCents: 40000,
    });
    account.settle("pay", 10000, "COMPLETED");
    account.credit("return", 10000);
    const result = replayTransaction(account.trace("pay"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/400", "400/400", "400/400", "400/400"]);
    expect(result.final.holds["hold_pay"]).toMatchObject({ kind: "PENDING_PAYMENT", status: "RELEASED" });
    expect(money(replayTransaction(account.trace("return")).steps)).toEqual(["500/500", "500/500"]);
    expectAccountReplays(account);
  });
});

describe("outbound payment network step", () => {
  it("SUBMITTED_TO_NETWORK moves no money and is explained as such", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("pay", 10000, "PENDING_PAYMENT");
    account.sentToNetwork("pay");
    account.settle("pay", 10000, "COMPLETED");
    const result = replayTransaction(account.trace("pay"));
    expect(result.consistent).toBe(true);
    expect(result.steps.map((s) => s.explanation)).toEqual(["hold_created", "submitted_to_network", "settlement_released_hold", "hold_released_with_settlement", "status_changed"]);
    expect(money(result.steps)).toEqual(["500/400", "500/400", "400/400", "400/400", "400/400"]);
    expectAccountReplays(account);
  });
});

describe("transaction replay with other activity interleaved", () => {
  it("explains its own deltas; other transactions' effects show as other activity, and it still checks", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.hold("other", 2000); // another authorization stays active throughout
    account.fund("topup", 10000);
    account.settle("buy", 6500);

    const result = replayTransaction(account.trace("buy"));
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/420", "535/515", "535/515", "535/515"]);
    // Between the authorization and the settlement: −$20 held elsewhere, +$100 funding.
    expect(result.steps[1].otherActivity).toEqual({ ledgerCents: 10000, availableCents: 8000 });
    expect(result.steps[1].before).toMatchObject({ ledgerCents: 60000, availableCents: 50000 });
    // Available before the settlement already includes the other $20 hold: it comes from the
    // recorded running balance, not from ledger − this transaction's holds.
    expect(result.steps[1].after.availableCents - result.steps[1].before.availableCents).toBe(-6500 + 8000);
    expectAccountReplays(account);
  });
});

describe("verification", () => {
  function story() {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.settle("buy", 6500);
    return account;
  }

  it("a corrupted available_after on a row is reported as the first divergence, at that step", () => {
    const account = story();
    const trace = account.trace("buy");
    trace[0] = { ...trace[0], recorded: { ...trace[0].recorded, availableCents: 41000 } };
    const result = replayTransaction(trace);
    expect(result.consistent).toBe(false);
    expect(result.divergence).toEqual({
      stepIndex: 0,
      reason: "balances",
      eventId: trace[0].id,
      accountSeq: 4,
      replayed: { ledgerCents: 50000, availableCents: 42000 },
      recorded: { ledgerCents: 50000, availableCents: 41000 },
    });
    expect(result.steps[0].matches).toBe(false);
  });

  it("a corrupted row between consecutive rows flags only its own step", () => {
    const account = story();
    const trace = account.trace("buy").map((row) => (row.kind === "LEDGER_POSTED" ? { ...row, recorded: { ...row.recorded, availableCents: 40000 } } : row));
    // The next rows' recordedBefore is the corrupted value; consecutive rows don't rebase onto it.
    const next = trace.map((row, i) => (i > 0 ? { ...row, recordedBefore: i === 2 ? trace[1].recorded : row.recordedBefore } : row));
    const result = replayTransaction(next);
    expect(result.steps.map((s) => s.matches)).toEqual([true, false, true, true]);
    expect(result.steps.every((s) => s.otherActivity === null)).toBe(true);
    expect(result.divergence?.stepIndex).toBe(1);
  });

  it("a corrupted ledger delta makes the account replay diverge and disagree with the cache", () => {
    const account = story();
    const rows = account.rows.map((row) => (row.accountSeq === 5 ? { ...row, ledgerDeltaCents: -6000 } : row));
    const result = replayAccount(rows);
    expect(result.consistent).toBe(false);
    expect(result.divergence).toMatchObject({ stepIndex: 4, accountSeq: 5, replayed: { ledgerCents: 44000 }, recorded: { ledgerCents: 43500 } });
    expect(accountMismatches(result, account.stored())).toEqual([
      "replayed ledger 44000 ≠ cached balance 43500",
      "replayed ledger 44000 ≠ sum of ledger entries 43500",
      "replayed available 44000 ≠ available 43500",
    ]);
  });

  it("reports active holds that replay and the holds table disagree on", () => {
    const account = story();
    const result = replayAccount(account.rows);
    expect(accountMismatches(result, { ...account.stored(), activeHoldIds: ["hold_buy"] })).toEqual(["replayed active holds [] ≠ active holds [hold_buy]"]);
  });

  it("is deterministic and never mutates its input", () => {
    const account = story();
    const trace = account.trace("buy");
    const frozen = JSON.parse(JSON.stringify(trace));
    const first = replayTransaction(trace);
    expect(replayTransaction(trace)).toEqual(first);
    expect(trace).toEqual(frozen);
    expect(apply(EMPTY_STATE, pairSettlements(trace)[0]).state).toEqual(apply(EMPTY_STATE, pairSettlements(trace)[0]).state);
  });

  it("an empty trace replays to its starting state", () => {
    expect(replayTransaction([])).toMatchObject({ steps: [], consistent: true, final: EMPTY_STATE });
  });

  it("a posting whose delta differs from its ledger entry is a divergence even when balances add up", () => {
    const account = story();
    const trace = account.trace("buy").map((row) => (row.kind === "LEDGER_POSTED" ? { ...row, ledgerEntryCents: -6000 } : row));
    const result = replayTransaction(trace);
    expect(result.consistent).toBe(false);
    expect(result.divergence).toMatchObject({ stepIndex: 1, reason: "ledger_entry", replayed: { ledgerCents: 43500, availableCents: 43500 } });
    expect(replayTransaction(account.trace("buy").map((row) => (row.kind === "LEDGER_POSTED" ? { ...row, ledgerEntryCents: -6500 } : row))).consistent).toBe(true);
    expect(replayTransaction(account.trace("buy").map((row) => (row.kind === "LEDGER_POSTED" ? { ...row, ledgerEntryCents: null } : row))).consistent).toBe(false);
  });

  it("a post and a release in two separate database transactions at consecutive account_seq are not paired, and still replay", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("pay", 10000, "PENDING_PAYMENT");
    account.postThenRelease("pay", 10000);
    const trace = account.trace("pay");
    expect(trace.map((row) => row.accountSeq)).toEqual([4, 5, 6]);
    expect(pairSettlements(trace).map((e) => [e.releasesHoldId ?? null, e.releasedBySettlement ?? false])).toEqual([
      [null, false],
      [null, false],
      [null, false],
    ]);
    const result = replayTransaction(trace);
    expect(result.consistent).toBe(true);
    expect(money(result.steps)).toEqual(["500/400", "400/300", "400/400"]);
    expect(result.steps.map((s) => s.explanation)).toEqual(["hold_created", "ledger_posted", "hold_released"]);
    expectAccountReplays(account);
  });

  it("pairs a posting with a hold release only when they are consecutive on the account", () => {
    const account = story();
    const trace = account.trace("buy");
    expect(pairSettlements(trace).map((e) => [e.kind, e.releasesHoldId ?? null, e.releasedBySettlement ?? false])).toEqual([
      ["HOLD_CREATED", null, false],
      ["LEDGER_POSTED", "hold_buy", false],
      ["HOLD_RELEASED", null, true],
      ["STATUS_CHANGED", null, false],
    ]);
    const gap = trace.map((e) => (e.kind === "HOLD_RELEASED" ? { ...e, accountSeq: e.accountSeq + 1 } : e));
    expect(pairSettlements(gap)[1].releasesHoldId).toBeUndefined();
  });
});

describe("money graph", () => {
  it("follows external authorization → hold → external settlement → ledger entry → balance", () => {
    const account = new Account();
    account.fund("fund", 50000);
    account.hold("buy", 8000);
    account.settle("buy", 6500);
    const refs = ["auth_1", "settle_1", "settle_1", "settle_1"];
    const graph = moneyGraph({
      transaction: { id: "buy", type: "CARD_PURCHASE", provider: "increase" },
      steps: account.trace("buy").map((row, i) => ({
        id: row.id,
        accountSeq: row.accountSeq,
        kind: row.kind,
        providerRef: refs[i],
        eventId: i === 0 ? "evt_a" : "evt_b",
        ledgerEntryId: row.kind === "LEDGER_POSTED" ? "le_1" : null,
        recorded: row.recorded,
      })),
      ledgerEntries: [{ id: "le_1", entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500 }],
      holds: [{ id: "hold_buy", kind: "CARD_AUTHORIZATION", status: "RELEASED", amountCents: 8000 }],
      externalEvents: [
        { id: "evt_a", provider: "increase", externalEventId: "inc_evt_a", eventType: "card_payment.created" },
        { id: "evt_b", provider: "increase", externalEventId: "inc_evt_b", eventType: "card_payment.updated" },
      ],
      related: [{ id: "refund", type: "CARD_REVERSAL", relation: "follow_up" }],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["external:auth_1", "hold:hold_buy", "external:settle_1", "ledger:le_1", "balance", "transaction:refund"]);
    expect(graph.nodes[0]).toMatchObject({ type: "external", role: "authorization", eventIds: ["evt_a"], externalEventIds: ["inc_evt_a"], stepIds: ["row_4"] });
    expect(graph.nodes[2]).toMatchObject({ role: "settlement", stepIds: ["row_5", "row_6", "row_7"] });
    expect(graph.nodes[4]).toMatchObject({ ledgerCents: 43500, availableCents: 43500, stepIds: ["row_7"] });
    expect(graph.edges).toEqual([
      { from: "external:auth_1", to: "hold:hold_buy", kind: "created" },
      { from: "external:settle_1", to: "ledger:le_1", kind: "posted" },
      { from: "hold:hold_buy", to: "external:settle_1", kind: "closed_by" },
      { from: "ledger:le_1", to: "balance", kind: "updated" },
      { from: "balance", to: "transaction:refund", kind: "followed_by" },
    ]);
    expect(JSON.stringify(graph)).not.toContain("payload");
  });

  it("an expired authorization gives the funds back through its expiry; an active one reserves them", () => {
    const step = (id: string, kind: TraceKind, providerRef: string | null) => ({ id, accountSeq: 1, kind, providerRef, eventId: null, ledgerEntryId: null, recorded: { ledgerCents: 50000, availableCents: 50000 } });
    const base = { transaction: { id: "buy", type: "CARD_PURCHASE" as const, provider: "increase" }, ledgerEntries: [], externalEvents: [], related: [] };
    const expired = moneyGraph({
      ...base,
      steps: [step("s1", "HOLD_CREATED", "auth"), step("s2", "HOLD_EXPIRED", "exp"), step("s3", "STATUS_CHANGED", "exp")],
      holds: [{ id: "h", kind: "CARD_AUTHORIZATION", status: "EXPIRED", amountCents: 8000 }],
    });
    expect(expired.edges).toContainEqual({ from: "hold:h", to: "external:exp", kind: "closed_by" });
    expect(expired.edges).toContainEqual({ from: "external:exp", to: "balance", kind: "restored" });
    const active = moneyGraph({ ...base, steps: [step("s1", "HOLD_CREATED", "auth")], holds: [{ id: "h", kind: "CARD_AUTHORIZATION", status: "ACTIVE", amountCents: 8000 }] });
    expect(active.edges).toContainEqual({ from: "hold:h", to: "balance", kind: "reserves" });
  });
});
