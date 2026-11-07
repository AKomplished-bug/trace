import type { CardPaymentElement } from "../cards";
import type { TransferSnapshot } from "../payments";

/**
 * Reconciliation: our transactions against the provider's records, as fetched from its API (never
 * our webhook copies). Pure: callers load both sides and store the results.
 *
 * Records pair on (type, provider object id) — `transactions.provider_object_id` — or, when ours has
 * no provider id yet, on the transaction id the provider record names. The element behind the
 * provider's current state (charge, settlement, refund, return) must be a `provider_ref` on our
 * trace. A grace window keeps "not arrived yet" (PENDING_EXTERNAL) apart from "missing" or
 * "different": either side may still be catching up within it.
 */

export const RECONCILIATION_STATUSES = [
  "MATCHED",
  "AMOUNT_MISMATCH",
  "STATUS_MISMATCH",
  "MISSING_INTERNAL",
  "MISSING_EXTERNAL",
  "DUPLICATE",
  "PENDING_EXTERNAL",
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Why a record got its status; a fixed set, stored with the record. */
export type ReconciliationReason =
  | "amount"
  | "currency"
  | "status"
  | "reference"
  | "within_grace"
  | "second_external_record"
  | "nothing_at_provider";

/** Transaction types that have a provider record to compare with (not ADJUSTMENT). */
export type ReconciledType = "FUNDING" | "CARD_PURCHASE" | "CARD_REVERSAL" | "OUTBOUND_PAYMENT" | "PAYMENT_RETURN";

/** Our side of one transaction. */
export interface InternalRecord {
  transactionId: string;
  accountId: string;
  type: ReconciledType;
  status: string;
  /** Positive cents; see `internalAmountCents`. */
  amountCents: number;
  providerObjectId: string | null;
  /** Every `provider_ref` on the transaction's trace. */
  providerRefs: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}

/** The provider's side, mapped onto our type and status vocabulary. */
export interface ExternalRecord {
  type: ReconciledType;
  /** The provider object, matched against `transactions.provider_object_id`. */
  id: string;
  /** The element behind its current state, matched against `provider_ref`; null when there is none yet. */
  ref: string | null;
  /** In our status vocabulary for `type`; "UNSUPPORTED" when the provider shows a step we don't model. */
  status: string;
  amountCents: number;
  currency: string;
  /** Our transaction id when the provider record names it (PaymentIntent metadata, ACH idempotency key). */
  transactionId: string | null;
  createdAt: Date;
  /** The latest change the provider shows. */
  updatedAt: Date;
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  reason: ReconciliationReason | null;
  type: ReconciledType;
  internal: InternalRecord | null;
  external: ExternalRecord | null;
}

export interface ClassifyOptions {
  /** Records created in [start, end) are this run's; others are loaded only to pair with them. */
  window: { start: Date; end: Date };
  /** When the comparison runs. */
  asOf: Date;
  /** A side that changed this recently may still be catching up: PENDING_EXTERNAL, not a mismatch. */
  graceMs: number;
}

/**
 * What our transaction moved, in positive cents: once posted, the ledger entry plus any ADJUSTMENT
 * linked to it (so a resolved difference matches next time); before that, the transaction amount.
 */
export function internalAmountCents(transactionAmountCents: number, postedNetCents: number | null): number {
  return postedNetCents === null ? transactionAmountCents : Math.abs(postedNetCents);
}

/** A Stripe-style payment (funding) as the adapter returns it. */
export interface FundingPaymentInput {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  amountCents: number;
  amountReceivedCents: number;
  currency: string;
  chargeId: string | null;
  metadata: { transactionId: string | null };
  createdAt: Date;
}

const FUNDING_STATUS = { PENDING: "PENDING", SUCCEEDED: "SETTLED", FAILED: "FAILED" } as const;

/** A funding payment: SUCCEEDED → SETTLED for the amount received, with its charge as the ref. */
export function fundingRecord(payment: FundingPaymentInput): ExternalRecord {
  const succeeded = payment.status === "SUCCEEDED";
  return {
    type: "FUNDING",
    id: payment.id,
    ref: succeeded ? payment.chargeId : null,
    status: FUNDING_STATUS[payment.status],
    amountCents: succeeded ? payment.amountReceivedCents : payment.amountCents,
    currency: payment.currency,
    transactionId: payment.metadata.transactionId,
    // A PaymentIntent has no update time; we confirm it in the request that creates it.
    createdAt: payment.createdAt,
    updatedAt: payment.createdAt,
  };
}

export interface CardPaymentInput {
  id: string;
  elements: readonly CardPaymentElement[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A card payment: one CARD_PURCHASE record for the purchase (one per settlement, so a second
 * settlement shows as a duplicate) and one CARD_REVERSAL record per refund. The purchase status
 * follows our card state machine: SETTLED once settled, else the first void or expiry, else
 * AUTHORIZED for what is still authorized. Any element we don't model makes the purchase
 * UNSUPPORTED (our side refused it, so it must surface).
 */
export function cardPaymentRecords(payment: CardPaymentInput): ExternalRecord[] {
  const base = { id: payment.id, currency: "USD", transactionId: null, createdAt: payment.createdAt, updatedAt: payment.updatedAt };
  const records: ExternalRecord[] = [];
  const auth = payment.elements.find((e) => e.kind === "AUTHORIZATION");
  const unsupported = payment.elements.find((e) => e.kind === "UNSUPPORTED");
  const settlements = payment.elements.filter((e) => e.kind === "SETTLEMENT");
  const authorizedCents = auth?.kind === "AUTHORIZATION" ? auth.amountCents : 0;

  if (unsupported) {
    records.push({ ...base, type: "CARD_PURCHASE", ref: unsupported.id, status: "UNSUPPORTED", amountCents: authorizedCents });
  } else if (settlements.length) {
    for (const s of settlements) records.push({ ...base, type: "CARD_PURCHASE", ref: s.id, status: "SETTLED", amountCents: s.amountCents });
  } else if (auth) {
    const closing = payment.elements.find((e) => e.kind === "EXPIRATION" || (e.kind === "REVERSAL" && e.remainingAuthorizationCents === 0));
    const voidedCents = payment.elements.reduce((sum, e) => sum + (e.kind === "REVERSAL" ? e.amountCents : 0), 0);
    if (closing) {
      records.push({ ...base, type: "CARD_PURCHASE", ref: closing.id, status: closing.kind === "EXPIRATION" ? "EXPIRED" : "REVERSED", amountCents: authorizedCents });
    } else {
      records.push({ ...base, type: "CARD_PURCHASE", ref: auth.id, status: "AUTHORIZED", amountCents: authorizedCents - voidedCents });
    }
  }

  for (const e of payment.elements) {
    if (e.kind === "REFUND") records.push({ ...base, type: "CARD_REVERSAL", id: e.id, ref: e.id, status: "SETTLED", amountCents: e.amountCents });
  }
  return records;
}

export interface TransferInput {
  id: string;
  amountCents: number;
  currency: string;
  snapshot: TransferSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An outbound transfer: the OUTBOUND_PAYMENT record (rejected → FAILED, returned before settling →
 * RETURNED, settled → COMPLETED, otherwise SUBMITTED), plus a PAYMENT_RETURN record when it came
 * back after settling. `transactionId` is our payment's transaction, when the transfer names it.
 */
export function transferRecords(transfer: TransferInput, transactionId: string | null): ExternalRecord[] {
  const base = {
    id: transfer.id,
    amountCents: transfer.amountCents,
    currency: transfer.currency,
    transactionId,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  };
  const { snapshot } = transfer;
  if (snapshot.rejected) return [{ ...base, type: "OUTBOUND_PAYMENT", ref: null, status: "FAILED" }];
  if (snapshot.returned && !snapshot.settled) return [{ ...base, type: "OUTBOUND_PAYMENT", ref: snapshot.returned.id, status: "RETURNED" }];
  const payment: ExternalRecord = { ...base, type: "OUTBOUND_PAYMENT", ref: transfer.id, status: snapshot.settled ? "COMPLETED" : "SUBMITTED" };
  if (!snapshot.returned) return [payment];
  // A return after settlement is its own transaction on our side, linked by the same transfer id.
  return [payment, { ...base, type: "PAYMENT_RETURN", transactionId: null, ref: snapshot.returned.id, status: "COMPLETED" }];
}

const within = (at: Date, window: ClassifyOptions["window"]) => at >= window.start && at < window.end;
const key = (type: string, id: string) => `${type}\u0000${id}`;

/**
 * Classifies every pair, and every unpaired record created in the window:
 * - several provider records for one of ours: the one it tracks is compared, the rest DUPLICATE;
 * - different status: PENDING_EXTERNAL if either side changed within the grace window, else STATUS_MISMATCH;
 * - same status, different amount or currency: AMOUNT_MISMATCH;
 * - same status and amount, but the provider's element isn't on our trace: STATUS_MISMATCH ("reference");
 * - only ours: MISSING_EXTERNAL (PENDING_EXTERNAL within grace; MATCHED if it FAILED before the
 *   provider had anything);
 * - only theirs: MISSING_INTERNAL (PENDING_EXTERNAL within grace).
 */
export function classify(
  internals: readonly InternalRecord[],
  externals: readonly ExternalRecord[],
  options: ClassifyOptions,
): ReconciliationResult[] {
  const recent = (...times: Date[]) => times.some((t) => t.getTime() >= options.asOf.getTime() - options.graceMs);
  const byKey = new Map<string, InternalRecord>();
  const byId = new Map<string, InternalRecord>();
  for (const i of internals) {
    byId.set(i.transactionId, i);
    if (i.providerObjectId) byKey.set(key(i.type, i.providerObjectId), i);
  }

  // The same element listed twice (e.g. across pages) is one record.
  const unique = new Map<string, ExternalRecord>();
  for (const e of externals) unique.set(`${key(e.type, e.id)}\u0000${e.ref ?? ""}`, e);
  const sorted = [...unique.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const paired = new Map<string, ExternalRecord[]>();
  const results: ReconciliationResult[] = [];
  for (const e of sorted) {
    const named = e.transactionId ? byId.get(e.transactionId) : undefined;
    const internal = byKey.get(key(e.type, e.id)) ?? (named?.type === e.type ? named : undefined);
    if (internal) {
      paired.set(internal.transactionId, [...(paired.get(internal.transactionId) ?? []), e]);
    } else if (within(e.createdAt, options.window)) {
      const pending = recent(e.updatedAt);
      results.push({ status: pending ? "PENDING_EXTERNAL" : "MISSING_INTERNAL", reason: pending ? "within_grace" : null, type: e.type, internal: null, external: e });
    }
  }

  for (const internal of internals) {
    const group = paired.get(internal.transactionId);
    if (!group) {
      if (!within(internal.createdAt, options.window)) continue;
      const result = { type: internal.type, internal, external: null };
      if (internal.status === "FAILED" && !internal.providerObjectId) results.push({ ...result, status: "MATCHED", reason: "nothing_at_provider" });
      else if (recent(internal.updatedAt)) results.push({ ...result, status: "PENDING_EXTERNAL", reason: "within_grace" });
      else results.push({ ...result, status: "MISSING_EXTERNAL", reason: null });
      continue;
    }
    if (!within(internal.createdAt, options.window) && !group.some((e) => within(e.createdAt, options.window))) continue;

    const tracked = group.filter((e) => e.id === internal.providerObjectId);
    const candidates = tracked.length ? tracked : group;
    const primary = candidates.find((e) => e.ref !== null && internal.providerRefs.includes(e.ref)) ?? candidates[0];
    results.push({ ...compare(internal, primary, recent), type: internal.type, internal, external: primary });
    for (const extra of group) {
      if (extra !== primary) results.push({ status: "DUPLICATE", reason: "second_external_record", type: internal.type, internal, external: extra });
    }
  }
  return results;
}

function compare(
  internal: InternalRecord,
  external: ExternalRecord,
  recent: (...times: Date[]) => boolean,
): { status: ReconciliationStatus; reason: ReconciliationReason | null } {
  if (internal.status !== external.status) {
    return recent(internal.updatedAt, external.updatedAt) ? { status: "PENDING_EXTERNAL", reason: "within_grace" } : { status: "STATUS_MISMATCH", reason: "status" };
  }
  if (external.currency !== "USD") return { status: "AMOUNT_MISMATCH", reason: "currency" };
  if (internal.amountCents !== external.amountCents) return { status: "AMOUNT_MISMATCH", reason: "amount" };
  if (external.ref !== null && !internal.providerRefs.includes(external.ref)) return { status: "STATUS_MISMATCH", reason: "reference" };
  return { status: "MATCHED", reason: null };
}

/** Results per status (every status present, zero if none). */
export function countByStatus(results: readonly { status: ReconciliationStatus }[]): Record<ReconciliationStatus, number> {
  const counts = Object.fromEntries(RECONCILIATION_STATUSES.map((s) => [s, 0])) as Record<ReconciliationStatus, number>;
  for (const r of results) counts[r.status] += 1;
  return counts;
}

const DEBIT_TYPES: ReadonlySet<ReconciledType> = new Set(["CARD_PURCHASE", "OUTBOUND_PAYMENT"]);

/**
 * The signed ADJUSTMENT (credit +, debit −) that would bring our ledger to the provider's amount,
 * given the difference external − internal: a debit type the provider took more for needs a
 * further debit; a credit type it paid more for needs a further credit. Null when nothing differs.
 */
export function suggestedAdjustmentCents(type: string, differenceCents: number | null): number | null {
  if (!differenceCents) return null;
  return DEBIT_TYPES.has(type as ReconciledType) ? -differenceCents : differenceCents;
}
