import { and, eq, inArray, sql } from "drizzle-orm";
import { withTransaction, type Db, type Tx } from "../db/client";
import { holds, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { createFakeIncrease, seedCardPayment, type CardPaymentJson } from "../integrations/increase/fake-increase";
import settledCardPayment from "../integrations/increase/fixtures/card_payment.settled.json";
import { createFakeStripe, seedIntent } from "../integrations/stripe/fake-stripe";
import succeededIntent from "../integrations/stripe/fixtures/payment_intent.succeeded.json";
import { logger as rootLogger, type Logger } from "../lib/logger";
import { lockAccount } from "./accounts";
import { postLedgerEntry } from "./ledger";
import { appendTraceEvent } from "./trace";

/** Fixed ids, and provider "demo" so the story can't be mistaken for (or reconciled against) real provider records. */
export const DEMO = {
  provider: "demo",
  fundingTransactionId: "00000000-0000-4000-8000-000000000041",
  purchaseTransactionId: "00000000-0000-4000-8000-000000000042",
  fundingCents: 50000,
  authorizedCents: 8000,
  settledCents: 6500,
} as const;

/**
 * Dev-only: the core story on the seeded Acme account — fund $500, authorize $80 (available
 * $420), settle $65 and release the hold (available $435) — through the ledger, hold and trace
 * services, one database transaction per step like the API and worker would. Every status change
 * writes STATUS_CHANGED after its effects, as the real funding flow does (created → PENDING;
 * LEDGER_POSTED then PENDING → SETTLED), so the demo trace looks like production. Idempotent:
 * re-running changes nothing. There is no authorization service yet, so the transaction and hold
 * rows are inserted here, under the account lock. Refuses to run in production.
 */
export async function seedDemoStory(db: Db, logger: Logger = rootLogger): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("The demo seed is for development only; refusing to run with NODE_ENV=production");
  const log = logger.child({ account_id: SEED.accountId });

  await withTransaction(db, async (tx) => {
    await lockAccount(tx, SEED.accountId);
    const [created] = await tx
      .insert(transactions)
      .values({
        id: DEMO.fundingTransactionId,
        accountId: SEED.accountId,
        type: "FUNDING",
        status: "PENDING",
        amountCents: DEMO.fundingCents,
        provider: DEMO.provider,
        providerObjectId: "demo_payment_intent_1",
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    if (created) {
      await appendTraceEvent(tx, {
        accountId: SEED.accountId,
        transactionId: DEMO.fundingTransactionId,
        kind: "STATUS_CHANGED",
        amountCents: DEMO.fundingCents,
        toStatus: "PENDING",
      });
    }
  });

  await withTransaction(db, async (tx) => {
    await postLedgerEntry(
      tx,
      {
        accountId: SEED.accountId,
        transactionId: DEMO.fundingTransactionId,
        entryType: "FUNDING_CREDIT",
        amountCents: DEMO.fundingCents,
        providerRef: "demo_charge_1",
      },
      log,
    );
    await setStatus(tx, DEMO.fundingTransactionId, DEMO.fundingCents, "PENDING", "SETTLED", "demo_charge_1");
  });

  await withTransaction(db, async (tx) => {
    await lockAccount(tx, SEED.accountId);
    await tx
      .insert(transactions)
      .values({
        id: DEMO.purchaseTransactionId,
        accountId: SEED.accountId,
        type: "CARD_PURCHASE",
        status: "AUTHORIZED",
        amountCents: DEMO.authorizedCents,
        provider: DEMO.provider,
        providerObjectId: "demo_card_payment_1",
      })
      .onConflictDoNothing();
    const [hold] = await tx
      .insert(holds)
      .values({
        transactionId: DEMO.purchaseTransactionId,
        accountId: SEED.accountId,
        kind: "CARD_AUTHORIZATION",
        amountCents: DEMO.authorizedCents,
      })
      .onConflictDoNothing({ target: holds.transactionId })
      .returning({ id: holds.id });
    if (hold) {
      await appendTraceEvent(tx, {
        accountId: SEED.accountId,
        transactionId: DEMO.purchaseTransactionId,
        kind: "HOLD_CREATED",
        amountCents: DEMO.authorizedCents,
        providerRef: "demo_authorization_1",
      });
    }
  });

  await withTransaction(db, async (tx) => {
    await postLedgerEntry(
      tx,
      {
        accountId: SEED.accountId,
        transactionId: DEMO.purchaseTransactionId,
        entryType: "CARD_SETTLEMENT_DEBIT",
        amountCents: -DEMO.settledCents,
        providerRef: "demo_settlement_1",
        releaseHoldForTransactionId: DEMO.purchaseTransactionId,
      },
      log,
    );
    await setStatus(tx, DEMO.purchaseTransactionId, DEMO.authorizedCents, "AUTHORIZED", "SETTLED", "demo_settlement_1");
  });
  log.info({ outcome: "seeded" }, "demo story applied");
}

type Status = (typeof transactions.$inferSelect)["status"];

// Conditional on the current status, so a re-run (or a status already moved on) is a no-op;
// the STATUS_CHANGED step is written only when the status actually changed.
async function setStatus(tx: Tx, id: string, amountCents: number, from: Status, to: Status, providerRef: string) {
  const [updated] = await tx
    .update(transactions)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(transactions.id, id), eq(transactions.status, from)))
    .returning({ id: transactions.id });
  if (updated) {
    await appendTraceEvent(tx, {
      accountId: SEED.accountId,
      transactionId: id,
      kind: "STATUS_CHANGED",
      amountCents,
      fromStatus: from,
      toStatus: to,
      providerRef,
    });
  }
}

/**
 * Dev and test only: the providers' side of the demo story, from the Stripe and Increase fakes (no
 * real provider has "demo" records). Stripe agrees with the funding; Increase reports the card
 * purchase settled for `providerSettledCents` — $80 by default, against our $65 — so reconciling
 * provider "demo" finds the core demo's AMOUNT_MISMATCH. Run the demo story first.
 */
export async function demoReconciliationSource(db: Db, { providerSettledCents = DEMO.authorizedCents }: { providerSettledCents?: number } = {}) {
  const rows = await db
    .select({ id: transactions.id, createdAt: transactions.createdAt })
    .from(transactions)
    .where(inArray(transactions.id, [DEMO.fundingTransactionId, DEMO.purchaseTransactionId]));
  const createdAt = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error("Run the demo story (npm run db:seed:demo) before reconciling it");
    return row.createdAt;
  };

  const stripe = createFakeStripe();
  seedIntent(stripe, {
    ...structuredClone(succeededIntent),
    id: "demo_payment_intent_1",
    amount: DEMO.fundingCents,
    amount_received: DEMO.fundingCents,
    latest_charge: "demo_charge_1",
    metadata: { transaction_id: DEMO.fundingTransactionId },
    created: Math.floor(createdAt(DEMO.fundingTransactionId).getTime() / 1000),
  });

  const increase = createFakeIncrease();
  const at = createdAt(DEMO.purchaseTransactionId).toISOString();
  const [authorization, settlement] = structuredClone(settledCardPayment.elements) as Array<Record<string, unknown>>;
  Object.assign(authorization, { created_at: at });
  Object.assign(authorization.card_authorization as object, { id: "demo_authorization_1", amount: DEMO.authorizedCents });
  Object.assign(settlement, { created_at: at });
  Object.assign(settlement.card_settlement as object, { id: "demo_settlement_1", amount: providerSettledCents });
  seedCardPayment(increase, { ...(structuredClone(settledCardPayment) as CardPaymentJson), id: "demo_card_payment_1", created_at: at, elements: [authorization, settlement] });

  // The demo card isn't linked to Increase, so the fake's card is named as ours explicitly.
  return { payments: stripe.adapter, cards: increase.adapter, scope: { cardIds: [settledCardPayment.card_id], accountIds: [] } };
}
