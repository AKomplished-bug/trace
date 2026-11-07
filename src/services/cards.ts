import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { cards, externalEvents, holds, transactionEvents, transactions } from "../db/schema";
import { nextCardPurchaseStatus, type CardPaymentElement, type CardPurchaseStatus } from "../domain/cards";
import { ENTRY_TYPE_FOR_TRANSACTION } from "../domain/ledger";
import type { ProviderCardPayment } from "../integrations/card-provider";
import { PermanentEventError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { lockAccount } from "./accounts";
import { transitionHold } from "./holds";
import { postLedgerEntry } from "./ledger";
import { countOutcome } from "./metrics";
import { appendTraceEvent } from "./trace";

type Transaction = typeof transactions.$inferSelect;

/** No card of ours has this provider card id (yet, e.g. the bootstrap hasn't linked it). Retryable. */
export class CardNotFoundError extends Error {
  constructor(provider: string, providerCardId: string, cardPaymentId: string) {
    super(`No card with ${provider} id ${providerCardId} for card payment ${cardPaymentId}`);
    this.name = "CardNotFoundError";
  }
}

/**
 * A settlement, reversal or expiration whose card payment has no recorded authorization, e.g. a
 * force-posted settlement. Retryable, so it ends FAILED for Ops rather than posting unexplained.
 */
export class CardPurchaseNotFoundError extends Error {
  constructor(cardPaymentId: string, element: CardPaymentElement) {
    super(`${element.kind} ${element.id} on card payment ${cardPaymentId} has no recorded authorization`);
    this.name = "CardPurchaseNotFoundError";
  }
}

/** A lifecycle step we don't model (increment, partial reversal, second capture …). Permanent: Ops decides. */
export class UnsupportedCardElementError extends PermanentEventError {
  constructor(cardPaymentId: string, elementId: string, reason: string) {
    super(`card payment ${cardPaymentId} element ${elementId}: ${reason}`);
    this.name = "UnsupportedCardElementError";
  }
}

export interface CardPaymentInput {
  /** Our external_events id of the event being processed. */
  eventId: string;
  provider: string;
  /** The card payment as fetched from the provider's API, not the webhook payload. */
  cardPayment: ProviderCardPayment;
}

/**
 * Applies a card payment's lifecycle inside the event's processing transaction. The provider's
 * object holds every step so far, so each event re-reads all of them: under the account lock we
 * collect the steps already applied (their ids are on the purchase's trace rows as
 * `provider_ref`, or are a CARD_REVERSAL's `provider_object_id`) and apply only the new ones, in
 * the provider's order. A duplicate, an older snapshot, or a second event for the same state is
 * therefore a no-op.
 *
 * - authorization → CARD_PURCHASE AUTHORIZED + ACTIVE hold (HOLD_CREATED). The provider already
 *   approved it, so it is recorded even if it takes available below zero (HOLD_EXCEEDS_AVAILABLE).
 * - settlement → ledger debit for the settled amount, hold released (or SETTLED_AFTER_HOLD_CLOSED),
 *   purchase → SETTLED.
 * - reversal of the whole authorization before settlement → hold released, purchase → REVERSED.
 * - expiration → hold EXPIRED, purchase → EXPIRED.
 * - refund → new CARD_REVERSAL (one per refund, so partial refunds stack) crediting the ledger,
 *   linked to the purchase when it is on the same card payment.
 *
 * Retryable throws: unknown card; a step before its authorization. Permanent throws: steps we
 * don't model.
 */
export async function applyCardPayment(tx: Tx, input: CardPaymentInput, logger: Logger): Promise<void> {
  const { cardPayment, provider, eventId } = input;
  const log = logger.child({ event_id: eventId, provider_object_id: cardPayment.id });
  const [card] = await tx.select({ id: cards.id, accountId: cards.accountId }).from(cards).where(eq(cards.providerId, cardPayment.cardId));
  if (!card) throw new CardNotFoundError(provider, cardPayment.cardId, cardPayment.id);

  const accountId = card.accountId;
  await lockAccount(tx, accountId);
  const txLog = log.child({ account_id: accountId, card_id: card.id });
  const [found] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.provider, provider), eq(transactions.providerObjectId, cardPayment.id), eq(transactions.type, "CARD_PURCHASE")))
    .for("no key update");
  let purchase: Transaction | undefined = found;
  const applied = new Set(purchase ? await appliedSteps(tx, purchase.id) : []);
  let linkTo = purchase?.id;
  let appliedCount = 0;

  for (const element of cardPayment.elements) {
    if (applied.has(element.id) || element.kind === "NO_EFFECT") continue;
    const step = { accountId, eventId, providerRef: element.id };
    const elementLog = txLog.child({ element_id: element.id, element_kind: element.kind, transaction_id: purchase?.id });

    if (element.kind === "UNSUPPORTED") throw new UnsupportedCardElementError(cardPayment.id, element.id, element.reason);

    if (element.kind === "AUTHORIZATION") {
      if (purchase) throw new UnsupportedCardElementError(cardPayment.id, element.id, "a second authorization on one card payment is not modelled");
      purchase = await authorize(tx, { ...step, provider, cardPaymentId: cardPayment.id, element }, elementLog);
      linkTo = purchase.id;
    } else if (element.kind === "REFUND") {
      const refundId = await refund(tx, { ...step, provider, element, purchase }, elementLog);
      if (refundId) linkTo ??= refundId;
      else continue;
    } else {
      if (!purchase) throw new CardPurchaseNotFoundError(cardPayment.id, element);
      if (element.kind === "SETTLEMENT") {
        const to = nextCardPurchaseStatus(purchase.status, "SETTLE");
        if (!to) throw new UnsupportedCardElementError(cardPayment.id, element.id, `settlement on a purchase already ${purchase.status} (multiple captures are not modelled)`);
        await postLedgerEntry(
          tx,
          {
            accountId,
            transactionId: purchase.id,
            entryType: ENTRY_TYPE_FOR_TRANSACTION.CARD_PURCHASE,
            amountCents: -element.amountCents,
            externalEventId: eventId,
            providerRef: element.id,
            releaseHoldForTransactionId: purchase.id,
          },
          elementLog,
        );
        purchase = await setPurchaseStatus(tx, purchase, to, element.amountCents, step);
      } else {
        // A reversal or expiration only closes an open authorization; it never moves settled money.
        const event = element.kind === "REVERSAL" ? "VOID" : "EXPIRE";
        const to = nextCardPurchaseStatus(purchase.status, event);
        if (!to) {
          countOutcome("card_steps_total", { kind: element.kind, outcome: "no_effect" });
          elementLog.info({ outcome: "no_effect", status: purchase.status }, "authorization already closed; nothing to release");
          continue;
        }
        if (element.kind === "REVERSAL" && element.remainingAuthorizationCents > 0) {
          throw new UnsupportedCardElementError(cardPayment.id, element.id, "partial reversal of an authorization is not modelled");
        }
        await transitionHold(tx, { accountId, transactionId: purchase.id, event: event === "VOID" ? "RELEASE" : "EXPIRE", externalEventId: eventId, providerRef: element.id });
        purchase = await setPurchaseStatus(tx, purchase, to, element.amountCents, step);
      }
    }
    applied.add(element.id);
    appliedCount += 1;
    countOutcome("card_steps_total", { kind: element.kind, outcome: "applied" });
    elementLog.info({ outcome: "applied", transaction_id: purchase?.id, status: purchase?.status }, "card payment step applied");
  }

  if (linkTo) await tx.update(externalEvents).set({ transactionId: linkTo }).where(eq(externalEvents.id, eventId));
  txLog.info(
    { outcome: appliedCount ? "applied" : "no_new_steps", applied_steps: appliedCount, steps: cardPayment.elements.length, transaction_id: purchase?.id },
    appliedCount ? "card payment applied" : "card payment has no new steps; no effect",
  );
}

/** Ids of the provider steps already applied to a purchase: its trace refs and its refunds. */
async function appliedSteps(tx: Tx, purchaseId: string): Promise<string[]> {
  const traced = await tx
    .selectDistinct({ ref: transactionEvents.providerRef })
    .from(transactionEvents)
    .where(and(eq(transactionEvents.transactionId, purchaseId), sql`${transactionEvents.providerRef} IS NOT NULL`));
  const refunds = await tx
    .select({ ref: transactions.providerObjectId })
    .from(transactions)
    .where(and(eq(transactions.relatedTransactionId, purchaseId), eq(transactions.type, "CARD_REVERSAL")));
  return [...traced, ...refunds].flatMap((row) => (row.ref ? [row.ref] : []));
}

interface Step {
  accountId: string;
  eventId: string;
  providerRef: string;
}

async function authorize(
  tx: Tx,
  input: Step & { provider: string; cardPaymentId: string; element: Extract<CardPaymentElement, { kind: "AUTHORIZATION" }> },
  log: Logger,
): Promise<Transaction> {
  const { element } = input;
  const [purchase] = await tx
    .insert(transactions)
    .values({
      accountId: input.accountId,
      type: "CARD_PURCHASE",
      status: "AUTHORIZED",
      amountCents: element.amountCents,
      provider: input.provider,
      providerObjectId: input.cardPaymentId,
      counterparty: element.merchant,
    })
    .returning();
  await tx.insert(holds).values({
    transactionId: purchase.id,
    accountId: input.accountId,
    kind: "CARD_AUTHORIZATION",
    amountCents: element.amountCents,
    expiresAt: element.expiresAt,
  });
  const trace = await appendTraceEvent(tx, {
    accountId: input.accountId,
    transactionId: purchase.id,
    kind: "HOLD_CREATED",
    amountCents: element.amountCents,
    toStatus: "ACTIVE",
    externalEventId: input.eventId,
    providerRef: input.providerRef,
  });
  if (trace.availableAfterCents < 0) {
    await appendTraceEvent(tx, {
      accountId: input.accountId,
      transactionId: purchase.id,
      kind: "HOLD_EXCEEDS_AVAILABLE",
      amountCents: element.amountCents,
      externalEventId: input.eventId,
      providerRef: input.providerRef,
    });
    log.warn(
      { outcome: "authorized_over_available", transaction_id: purchase.id, available_cents: trace.availableAfterCents },
      "provider approved an authorization above the available balance; recorded",
    );
  }
  return purchase;
}

/** Records one refund as its own CARD_REVERSAL. Returns its id, or null if this refund was already recorded. */
async function refund(
  tx: Tx,
  input: Step & { provider: string; element: Extract<CardPaymentElement, { kind: "REFUND" }>; purchase: Transaction | undefined },
  log: Logger,
): Promise<string | null> {
  const { element, purchase } = input;
  const [reversal] = await tx
    .insert(transactions)
    .values({
      accountId: input.accountId,
      type: "CARD_REVERSAL",
      status: "SETTLED",
      amountCents: element.amountCents,
      provider: input.provider,
      providerObjectId: element.id,
      relatedTransactionId: purchase?.id ?? null,
      counterparty: element.merchant ?? purchase?.counterparty ?? null,
    })
    .onConflictDoNothing({ target: [transactions.provider, transactions.providerObjectId, transactions.type] })
    .returning({ id: transactions.id });
  if (!reversal) return null;
  await postLedgerEntry(
    tx,
    {
      accountId: input.accountId,
      transactionId: reversal.id,
      entryType: ENTRY_TYPE_FOR_TRANSACTION.CARD_REVERSAL,
      amountCents: element.amountCents,
      externalEventId: input.eventId,
      providerRef: element.id,
    },
    log,
  );
  await appendTraceEvent(tx, {
    accountId: input.accountId,
    transactionId: reversal.id,
    kind: "STATUS_CHANGED",
    amountCents: element.amountCents,
    toStatus: "SETTLED",
    externalEventId: input.eventId,
    providerRef: element.id,
  });
  // The provider doesn't always tie a refund to the original payment (it can arrive on its own card payment).
  if (!purchase) log.warn({ outcome: "unlinked_refund", transaction_id: reversal.id }, "refund on a card payment without a purchase; credited unlinked");
  return reversal.id;
}

/** Conditional status move plus its STATUS_CHANGED trace row. */
async function setPurchaseStatus(tx: Tx, purchase: Transaction, to: CardPurchaseStatus, amountCents: number, step: Step): Promise<Transaction> {
  const [updated] = await tx
    .update(transactions)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(transactions.id, purchase.id), eq(transactions.status, purchase.status)))
    .returning();
  if (!updated) throw new Error(`Card purchase ${purchase.id} changed status concurrently; expected ${purchase.status}`);
  await appendTraceEvent(tx, {
    accountId: step.accountId,
    transactionId: purchase.id,
    kind: "STATUS_CHANGED",
    amountCents,
    fromStatus: purchase.status,
    toStatus: to,
    externalEventId: step.eventId,
    providerRef: step.providerRef,
  });
  return updated;
}
