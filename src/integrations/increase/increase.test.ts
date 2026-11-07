import { createHmac } from "node:crypto";
import Increase from "increase";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { IdempotencyKeyReusedError, PaymentProviderError, ProviderRejectedError, WebhookVerificationError } from "../payment-provider";
import { createFakeIncrease, INCREASE_WEBHOOK_SECRET, seedCardPayment, signedIncreaseWebhook, type AchTransferJson, type CardPaymentJson } from "./fake-increase";
import achPending from "./fixtures/ach_transfer.pending_submission.json";
import achReturned from "./fixtures/ach_transfer.returned.json";
import authorized from "./fixtures/card_payment.authorized.json";
import expired from "./fixtures/card_payment.expired.json";
import refunded from "./fixtures/card_payment.refunded.json";
import reversed from "./fixtures/card_payment.reversed.json";
import standaloneRefund from "./fixtures/card_payment.standalone_refund.json";
import achCreatedEvent from "./fixtures/event.ach_transfer.created.json";
import createdEvent from "./fixtures/event.card_payment.created.json";
import pendingCreated from "./fixtures/event.pending_transaction.created.json";
import { achTransferIdFromEvent, cardPaymentIdFromEvent, IncreaseAdapter, toCardPaymentElement, toProviderCardPayment, toProviderTransfer, WEBHOOK_TOLERANCE_SECONDS } from ".";

// No fetch override: any API call would go to the real sandbox, so this one is only used for signatures.
const adapter = new IncreaseAdapter({ apiKey: "increase_unused", webhookSecret: INCREASE_WEBHOOK_SECRET });
const asPayment = (fixture: unknown) => fixture as Increase.CardPayment;

describe("verifyWebhook (Standard Webhooks)", () => {
  it("accepts a correctly signed event and returns its id, category and payload", () => {
    const { body, headers } = signedIncreaseWebhook(createdEvent);
    expect(adapter.verifyWebhook(body, headers)).toEqual({
      externalEventId: createdEvent.id,
      eventType: "card_payment.created",
      payload: createdEvent,
    });
  });

  it("accepts a webhook signed by the Standard Webhooks reference library with Increase's key scheme", () => {
    // The SDK's events.unwrap keys Standard Webhooks with base64(secret); sign the same way here.
    const reference = new Webhook(`whsec_${Buffer.from(INCREASE_WEBHOOK_SECRET).toString("base64")}`);
    const body = JSON.stringify(createdEvent);
    const now = new Date();
    const headers = new Headers({
      "webhook-id": createdEvent.id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": reference.sign(createdEvent.id, now, body),
    });
    expect(adapter.verifyWebhook(body, headers).externalEventId).toBe(createdEvent.id);
  });

  it("signs test webhooks the way the Increase SDK verifies them", () => {
    const sdk = new Increase({ apiKey: "increase_unused", webhookSecret: INCREASE_WEBHOOK_SECRET });
    const { body, headers } = signedIncreaseWebhook(createdEvent);
    expect(sdk.events.unwrap(body, { headers: Object.fromEntries(headers) })).toEqual(createdEvent);
    const forged = signedIncreaseWebhook(createdEvent, { secret: "attacker" });
    expect(() => sdk.events.unwrap(forged.body, { headers: Object.fromEntries(forged.headers) })).toThrow();
  });

  it("accepts any one valid signature among several (secret rotation)", () => {
    const { body, headers } = signedIncreaseWebhook(createdEvent);
    headers.set("webhook-signature", `v1,${Buffer.from("old-secret-signature").toString("base64")} ${headers.get("webhook-signature")}`);
    expect(adapter.verifyWebhook(body, headers).externalEventId).toBe(createdEvent.id);
  });

  it("rejects a tampered body, a wrong secret, a stale or future timestamp, and missing or malformed headers", () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = signedIncreaseWebhook(createdEvent);
    const cases: Array<[string, Headers]> = [
      [valid.body.replace("card_payment.created", "card_payment.updated"), valid.headers],
      [valid.body, signedIncreaseWebhook(createdEvent, { secret: "attacker" }).headers],
      [valid.body, signedIncreaseWebhook(createdEvent, { timestamp: now - WEBHOOK_TOLERANCE_SECONDS - 5 }).headers],
      [valid.body, signedIncreaseWebhook(createdEvent, { timestamp: now + WEBHOOK_TOLERANCE_SECONDS + 5 }).headers],
    ];
    for (const header of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers = new Headers(valid.headers);
      headers.delete(header);
      cases.push([valid.body, headers]);
    }
    const garbage = new Headers(valid.headers);
    garbage.set("webhook-signature", "garbage");
    const v2 = new Headers(valid.headers);
    v2.set("webhook-signature", valid.headers.get("webhook-signature")!.replace("v1,", "v2,"));
    cases.push([valid.body, garbage], [valid.body, v2]);
    for (const [body, headers] of cases) {
      expect(() => adapter.verifyWebhook(body, headers)).toThrow(WebhookVerificationError);
    }
  });

  it("rejects a correctly signed body that isn't an Increase event", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = "not json";
    const signature = createHmac("sha256", INCREASE_WEBHOOK_SECRET).update(`event_x.${timestamp}.${body}`).digest("base64");
    const headers = new Headers({ "webhook-id": "event_x", "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` });
    expect(() => adapter.verifyWebhook(body, headers)).toThrow(WebhookVerificationError);
  });
});

describe("mapping fixtures", () => {
  it("maps an authorization and settlement for a different amount", () => {
    expect(toProviderCardPayment(asPayment(refunded), "req_1")).toEqual({
      id: "card_payment_nd3k2kacrqjli8482ave",
      cardId: "card_oubs0hwk5rn6knuecxg2",
      requestId: "req_1",
      elements: [
        { kind: "AUTHORIZATION", id: "card_authorization_6iqxap6ivd0fo5eu3i8x", amountCents: 8000, merchant: "FIGMA.COM", expiresAt: new Date("2026-11-14T10:00:00Z") },
        { kind: "SETTLEMENT", id: "card_settlement_khv5kfeu0vndj291omg6", amountCents: 6500 },
        { kind: "REFUND", id: "card_refund_imgc2xwplh6t4r3gn16e", amountCents: 6500, merchant: "FIGMA.COM" },
      ],
    });
  });

  it("maps reversals, expirations and a refund on its own card payment", () => {
    expect(toProviderCardPayment(asPayment(reversed), null).elements[1]).toEqual({
      kind: "REVERSAL",
      id: "card_reversal_8vr9qy60cgf5d0slpb68",
      amountCents: 8000,
      remainingAuthorizationCents: 0,
    });
    expect(toProviderCardPayment(asPayment(expired), null).elements[1]).toEqual({
      kind: "EXPIRATION",
      id: "card_authorization_expiration_9xt0lw2z3dmwqgwsqmvq",
      amountCents: 8000,
    });
    expect(toProviderCardPayment(asPayment(standaloneRefund), null).elements).toEqual([
      { kind: "REFUND", id: "card_refund_q8w2mzt0x3n4b5v6c7d8", amountCents: 6500, merchant: "FIGMA.COM" },
    ]);
  });

  it("marks declines as no effect and steps we don't model as unsupported", () => {
    const auth = structuredClone(authorized.elements[0]);
    expect(toCardPaymentElement({ category: "card_decline", created_at: "2026-11-07T10:00:00Z", card_decline: { id: "card_decline_1" } } as unknown as Increase.CardPayment.Element)).toEqual({
      kind: "NO_EFFECT",
      id: "card_decline_1",
      category: "card_decline",
    });
    expect(toCardPaymentElement({ category: "card_increment", created_at: "2026-11-07T10:00:00Z", card_increment: { id: "card_increment_1" } } as unknown as Increase.CardPayment.Element)).toMatchObject({
      kind: "UNSUPPORTED",
      id: "card_increment_1",
    });
    auth.card_authorization.direction = "refund";
    expect(toCardPaymentElement(auth as unknown as Increase.CardPayment.Element)).toMatchObject({ kind: "UNSUPPORTED", reason: "refund authorizations are not modelled" });
  });

  it("reads the card payment id from card_payment events only", () => {
    expect(cardPaymentIdFromEvent(createdEvent)).toBe("card_payment_nd3k2kacrqjli8482ave");
    expect(() => cardPaymentIdFromEvent(pendingCreated)).toThrow();
    // Anonymous sandboxes prefix ids with sandbox_.
    expect(cardPaymentIdFromEvent({ ...createdEvent, associated_object_id: "sandbox_card_payment_x" })).toBe("sandbox_card_payment_x");
  });
});

describe("Increase API calls (fake Increase behind the real SDK)", () => {
  it("simulates authorize → settle → refund with the ids Increase needs, and re-fetches the result", async () => {
    const fake = createFakeIncrease();
    const auth = await fake.adapter.simulateAuthorization({ cardId: "card_1", amountCents: 8000, merchant: "FIGMA.COM" });
    expect(auth).toMatchObject({ declined: false, requestId: expect.stringMatching(/^req_fake_/) });
    expect(fake.requests[0]).toEqual({ method: "POST", path: "/simulations/card_authorizations", body: { card_id: "card_1", amount: 8000, merchant_descriptor: "FIGMA.COM" } });

    await fake.adapter.simulateSettlement({ cardPaymentId: auth.cardPaymentId, amountCents: 6500 });
    const pendingId = fake.cardPayments.get(auth.cardPaymentId)!.elements[0].card_authorization as { pending_transaction_id: string };
    expect(fake.requests.slice(1).map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", `/card_payments/${auth.cardPaymentId}`, {}],
      ["POST", "/simulations/card_settlements", { card_id: "card_1", pending_transaction_id: pendingId.pending_transaction_id, amount: 6500 }],
    ]);

    await fake.adapter.simulateReversal({ cardPaymentId: auth.cardPaymentId, amountCents: 2000 });
    expect(fake.requests.at(-1)).toMatchObject({ path: "/simulations/card_refunds", body: { transaction_id: expect.stringMatching(/^transaction_fake_/), amount: 2000 } });

    const payment = await fake.adapter.retrieveCardPayment(auth.cardPaymentId);
    expect(payment.elements.map((e) => [e.kind, "amountCents" in e ? e.amountCents : null])).toEqual([
      ["AUTHORIZATION", 8000],
      ["SETTLEMENT", 6500],
      ["REFUND", 2000],
    ]);
  });

  it("voids an unsettled authorization with a card reversal, and expires by card payment id", async () => {
    const fake = createFakeIncrease();
    const { cardPaymentId } = await fake.adapter.simulateAuthorization({ cardId: "card_1", amountCents: 8000 });
    await fake.adapter.simulateReversal({ cardPaymentId });
    expect(fake.requests.at(-1)).toEqual({ method: "POST", path: "/simulations/card_reversals", body: { card_payment_id: cardPaymentId } });
    await fake.adapter.simulateExpiration({ cardPaymentId });
    expect(fake.requests.at(-1)).toEqual({ method: "POST", path: "/simulations/card_authorization_expirations", body: { card_payment_id: cardPaymentId } });
  });

  it("reports a declined authorization instead of throwing", async () => {
    const fake = createFakeIncrease();
    fake.next = "decline";
    const result = await fake.adapter.simulateAuthorization({ cardId: "card_1", amountCents: 8000 });
    expect(result).toMatchObject({ declined: true, cardPaymentId: expect.stringMatching(/^card_payment_fake_/) });
  });

  it("times out once, without SDK retries, as a PaymentProviderError", async () => {
    const fake = createFakeIncrease({ timeoutMs: 50 });
    fake.next = "hang";
    const call = fake.adapter.simulateAuthorization({ cardId: "card_1", amountCents: 100 });
    await expect(call).rejects.toThrow(PaymentProviderError);
    await expect(call).rejects.not.toThrow(ProviderRejectedError);
    expect(fake.requests).toHaveLength(1);
  });

  it("reports Increase refusing a request as ProviderRejectedError with its error type only", async () => {
    const fake = createFakeIncrease();
    fake.next = "reject";
    const refused = fake.adapter.simulateExpiration({ cardPaymentId: "card_payment_x" });
    await expect(refused).rejects.toThrow(ProviderRejectedError);
    await expect(refused).rejects.toMatchObject({
      message: "Increase simulate card authorization expiration failed: invalid_operation_error",
      requestId: expect.stringMatching(/^req_fake_/),
    });
    await expect(fake.adapter.retrieveCardPayment("card_payment_missing")).rejects.toThrow("object_not_found_error");
    expect(fake.requests).toHaveLength(2);
  });

  it("bootstraps a funded sandbox account and card", async () => {
    const fake = createFakeIncrease();
    const result = await fake.adapter.bootstrapSandboxCard({ name: "Trace demo", fundingCents: 10_000_000 });
    expect(result).toEqual({ accountId: expect.stringMatching(/^account_fake_/), cardId: expect.stringMatching(/^card_fake_/), last4: "4242" });
    expect(fake.requests.map((r) => r.path)).toEqual(["/accounts", "/account_numbers", "/simulations/inbound_ach_transfers", "/cards"]);
    expect(fake.requests[2].body).toMatchObject({ amount: 10_000_000 });
  });

  it("returns a seeded fixture on retrieve", async () => {
    const fake = createFakeIncrease();
    seedCardPayment(fake, refunded as unknown as CardPaymentJson);
    expect((await fake.adapter.retrieveCardPayment(refunded.id)).elements).toHaveLength(3);
  });
});

describe("ACH transfers", () => {
  const transferInput = {
    sourceAccountId: "account_in71c4amph0vgo2qllky",
    amountCents: 10000,
    accountNumber: "987654321",
    routingNumber: "101050001",
    recipientName: "Globex Supplies",
    statementDescriptor: "Invoice 2468",
    idempotencyKey: "payment-1",
  };

  it("maps a pending and a returned-after-settlement transfer, without the account number", () => {
    expect(toProviderTransfer(achPending as unknown as Increase.ACHTransfer, "req_1")).toEqual({
      id: achPending.id,
      amountCents: 10000,
      currency: "USD",
      status: "pending_submission",
      idempotencyKey: achPending.idempotency_key,
      snapshot: { submittedToNetwork: false, settled: false, returned: null, rejected: false },
      requestId: "req_1",
    });
    const returned = toProviderTransfer(achReturned as unknown as Increase.ACHTransfer, null);
    expect(returned.snapshot).toEqual({
      submittedToNetwork: true,
      settled: true,
      returned: { id: achReturned.return.transaction_id, reason: "no_account" },
      rejected: false,
    });
    expect(JSON.stringify(returned)).not.toContain(achReturned.account_number);
    const rejected = toProviderTransfer({ ...achPending, status: "rejected" } as unknown as Increase.ACHTransfer, null);
    expect(rejected.snapshot.rejected).toBe(true);
  });

  it("reads the transfer id from ach_transfer events only", () => {
    expect(achTransferIdFromEvent(achCreatedEvent)).toBe(achCreatedEvent.associated_object_id);
    expect(() => achTransferIdFromEvent(createdEvent)).toThrow();
    expect(achTransferIdFromEvent({ ...achCreatedEvent, associated_object_id: "sandbox_ach_transfer_x" })).toBe("sandbox_ach_transfer_x");
  });

  it("creates a transfer with our Idempotency-Key; the same key and body returns the same transfer", async () => {
    const fake = createFakeIncrease();
    const created = await fake.adapter.createTransfer(transferInput);
    expect(fake.requests[0]).toEqual({
      method: "POST",
      path: "/ach_transfers",
      idempotencyKey: "payment-1",
      body: { account_id: transferInput.sourceAccountId, amount: 10000, account_number: "987654321", routing_number: "101050001", individual_name: "Globex Supplies", statement_descriptor: "Invoice 2468" },
    });
    expect(created).toMatchObject({ id: expect.stringMatching(/^ach_transfer_fake_/), amountCents: 10000, status: "pending_submission", idempotencyKey: "payment-1" });
    expect((await fake.adapter.createTransfer(transferInput)).id).toBe(created.id);
    expect(fake.achTransfers.size).toBe(1);
  });

  it("finds the transfer created with an idempotency key, or null when Increase has none", async () => {
    const fake = createFakeIncrease();
    const created = await fake.adapter.createTransfer(transferInput);
    await fake.adapter.createTransfer({ ...transferInput, idempotencyKey: "payment-2" });
    expect(await fake.adapter.findTransferByIdempotencyKey("payment-1")).toMatchObject({ id: created.id, idempotencyKey: "payment-1", requestId: expect.any(String) });
    expect(await fake.adapter.findTransferByIdempotencyKey("payment-3")).toBeNull();
    fake.next = "error";
    await expect(fake.adapter.findTransferByIdempotencyKey("payment-1")).rejects.toThrow(PaymentProviderError);
  });

  it("maps a reused key with a different body to IdempotencyKeyReusedError naming the existing transfer", async () => {
    const fake = createFakeIncrease();
    const created = await fake.adapter.createTransfer(transferInput);
    const reused = fake.adapter.createTransfer({ ...transferInput, amountCents: 20000 });
    await expect(reused).rejects.toThrow(IdempotencyKeyReusedError);
    await expect(fake.adapter.createTransfer({ ...transferInput, amountCents: 20000 })).rejects.toMatchObject({ resourceId: created.id, status: 409 });
  });

  it("4xx is ProviderRejectedError; 5xx and timeouts are PaymentProviderError, without SDK retries", async () => {
    const fake = createFakeIncrease({ timeoutMs: 50 });
    fake.next = "invalid";
    const invalid = await fake.adapter.createTransfer(transferInput).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(ProviderRejectedError);
    expect(invalid).toMatchObject({ message: "Increase create ACH transfer failed: invalid_parameters_error", status: 400 });
    fake.next = "error";
    const failed = await fake.adapter.createTransfer(transferInput).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(PaymentProviderError);
    expect(failed).not.toBeInstanceOf(ProviderRejectedError);
    fake.next = "hang";
    const timedOut = await fake.adapter.createTransfer(transferInput).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(PaymentProviderError);
    expect(timedOut).not.toBeInstanceOf(ProviderRejectedError);
    expect(fake.requests).toHaveLength(3);
  });

  it("simulates submit → settle → return, refusing a return before submission", async () => {
    const fake = createFakeIncrease();
    const { id } = await fake.adapter.createTransfer(transferInput);
    await expect(fake.adapter.simulateTransferReturn(id)).rejects.toThrow(ProviderRejectedError);
    expect((await fake.adapter.simulateTransferSubmission(id)).snapshot).toMatchObject({ submittedToNetwork: true, settled: false });
    expect((await fake.adapter.simulateTransferSettlement(id)).snapshot).toMatchObject({ settled: true, returned: null });
    const returned = await fake.adapter.simulateTransferReturn(id, "account_closed");
    expect(returned).toMatchObject({ status: "returned", snapshot: { settled: true, returned: { reason: "account_closed" } } });
    expect(fake.requests.slice(1).map((r) => r.path)).toEqual([
      `/simulations/ach_transfers/${id}/return`,
      `/simulations/ach_transfers/${id}/submit`,
      `/simulations/ach_transfers/${id}/settle`,
      `/simulations/ach_transfers/${id}/return`,
    ]);
    expect((await fake.adapter.retrieveTransfer(id)).status).toBe("returned");
  });
});

describe("list reads for reconciliation", () => {
  const window = { start: new Date("2026-11-07T00:00:00Z"), end: new Date("2026-11-08T00:00:00Z") };
  const at = (minutes: number) => new Date(window.start.getTime() + minutes * 60_000).toISOString();

  const card = (authorized as unknown as CardPaymentJson).card_id;

  it("lists every card payment on our card created in the window, across pages, with each page's request id", async () => {
    const fake = createFakeIncrease();
    for (let i = 0; i < 205; i++) {
      const elements = (authorized as unknown as CardPaymentJson).elements.map((e) => ({ ...e, created_at: at(i + 5) }));
      seedCardPayment(fake, { ...(authorized as unknown as CardPaymentJson), id: `card_payment_${i}`, created_at: at(i), elements });
    }
    seedCardPayment(fake, { ...(authorized as unknown as CardPaymentJson), id: "card_payment_before", created_at: "2026-11-06T23:59:59Z" });
    seedCardPayment(fake, { ...(authorized as unknown as CardPaymentJson), id: "card_payment_at_end", created_at: window.end.toISOString() });
    seedCardPayment(fake, { ...(authorized as unknown as CardPaymentJson), id: "card_payment_other_card", card_id: "card_someone_else", created_at: at(1) });

    const { items, requestIds } = await fake.adapter.listCardPayments(window, { cardId: card });
    expect(items).toHaveLength(205);
    expect(items.some((p) => ["card_payment_before", "card_payment_at_end", "card_payment_other_card"].includes(p.id))).toBe(false);
    expect(requestIds).toHaveLength(3);
    expect(requestIds.every((id) => id?.startsWith("req_fake_"))).toBe(true);
    const first = items.find((p) => p.id === "card_payment_0")!;
    expect(first).toMatchObject({ createdAt: new Date(at(0)), updatedAt: new Date(at(5)) });
    expect(first.elements[0].kind).toBe("AUTHORIZATION");
    expect(fake.requests.every((r) => r.method === "GET" && r.path === "/card_payments")).toBe(true);
  });

  it("lists our account's ACH transfers in the window; updatedAt is their latest step", async () => {
    const fake = createFakeIncrease();
    const transferFrom = (sourceAccountId: string, idempotencyKey: string) =>
      fake.adapter.createTransfer({
        sourceAccountId,
        amountCents: 10000,
        accountNumber: "987654321",
        routingNumber: "101050001",
        recipientName: "Globex",
        statementDescriptor: "Invoice",
        idempotencyKey,
      });
    const created = await transferFrom("account_1", "payment-1");
    const other = await transferFrom("account_someone_else", "theirs-1");
    for (const id of [created.id, other.id]) fake.achTransfers.get(id)!.created_at = "2026-11-07T01:00:00Z";
    const transfer = fake.achTransfers.get(created.id)!;
    transfer.settlement = { settled_at: "2026-11-07T03:00:00Z" };
    transfer.status = "submitted";
    const { items, requestIds } = await fake.adapter.listTransfers(window, { accountId: "account_1" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: created.id, idempotencyKey: "payment-1", createdAt: new Date("2026-11-07T01:00:00Z"), updatedAt: new Date("2026-11-07T03:00:00Z") });
    expect(items[0].snapshot.settled).toBe(true);
    expect(JSON.stringify(items[0])).not.toContain("987654321");
    expect(requestIds).toHaveLength(1);
  });

  it("fails a list read as a PaymentProviderError, and stops once the deadline passes", async () => {
    const fake = createFakeIncrease();
    fake.next = "error";
    await expect(fake.adapter.listCardPayments(window, { cardId: card })).rejects.toThrow("Increase list card payments failed: internal_server_error");
    const aborted = AbortSignal.abort();
    await expect(fake.adapter.listTransfers(window, { accountId: "account_1" }, aborted)).rejects.toThrow("deadline passed");
  });

  it("retrieves a card payment and a transfer with their created and last-changed times", async () => {
    const fake = createFakeIncrease();
    const elements = (authorized as unknown as CardPaymentJson).elements.map((e) => ({ ...e, created_at: at(30) }));
    seedCardPayment(fake, { ...(authorized as unknown as CardPaymentJson), id: "card_payment_old", created_at: at(0), elements });
    expect(await fake.adapter.retrieveCardPayment("card_payment_old")).toMatchObject({ id: "card_payment_old", createdAt: new Date(at(0)), updatedAt: new Date(at(30)) });
    fake.achTransfers.set("ach_transfer_old", { ...(structuredClone(achReturned) as AchTransferJson), id: "ach_transfer_old" });
    const transfer = await fake.adapter.retrieveTransfer("ach_transfer_old");
    expect(transfer.updatedAt.getTime()).toBeGreaterThanOrEqual(transfer.createdAt.getTime());
    expect(transfer.snapshot.returned).not.toBeNull();
  });
});
