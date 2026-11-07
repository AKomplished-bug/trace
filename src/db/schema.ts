import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { HOLD_KINDS, HOLD_STATUSES, LEDGER_ENTRY_TYPES, TRANSACTION_TYPES } from "../domain/ledger";
import { PAYMENT_STATUSES } from "../domain/payments";
import { RECONCILIATION_STATUSES } from "../domain/reconciliation";

// Amounts are integer cents in bigint columns, read as JS numbers (safe up to ±2^53).
const cents = (name: string) => bigint(name, { mode: "number" });
// All timestamps are timestamptz, stored UTC.
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();
const currency = () => char("currency", { length: 3 }).notNull().default("USD");
const usdOnly = (table: string) => check(`${table}_currency_usd`, sql`currency = 'USD'`);

export const userRole = pgEnum("user_role", ["OWNER", "OPS"]);
export const accountStatus = pgEnum("account_status", ["ACTIVE", "FROZEN", "CLOSED"]);
export const cardStatus = pgEnum("card_status", ["ACTIVE", "FROZEN", "CANCELED"]);
export const transactionType = pgEnum("transaction_type", TRANSACTION_TYPES);
export const transactionStatus = pgEnum("transaction_status", [
  "PENDING",
  "AUTHORIZED",
  // An outbound payment the provider has accepted but not yet settled.
  "SUBMITTED",
  "SETTLED",
  "COMPLETED",
  "REVERSED",
  "RETURNED",
  "EXPIRED",
  "FAILED",
]);
export const holdKind = pgEnum("hold_kind", HOLD_KINDS);
export const holdStatus = pgEnum("hold_status", HOLD_STATUSES);
export const paymentStatus = pgEnum("payment_status", PAYMENT_STATUSES);
export const ledgerEntryType = pgEnum("ledger_entry_type", LEDGER_ENTRY_TYPES);
export const externalEventStatus = pgEnum("external_event_status", [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "RETRY",
  "FAILED",
  "IGNORED",
]);
export const transactionEventKind = pgEnum("transaction_event_kind", [
  "STATUS_CHANGED",
  "HOLD_CREATED",
  "HOLD_RELEASED",
  "HOLD_EXPIRED",
  "LEDGER_POSTED",
  // A settlement posted after its hold had already expired or been released (late capture).
  "SETTLED_AFTER_HOLD_CLOSED",
  // A card authorization the provider approved that took available balance below zero.
  "HOLD_EXCEEDS_AVAILABLE",
  // The provider sent an outbound payment to the payment network (no money or status change).
  "SUBMITTED_TO_NETWORK",
]);
export const auditActorType = pgEnum("audit_actor_type", ["USER", "SYSTEM"]);
export const reconciliationRunStatus = pgEnum("reconciliation_run_status", ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
export const reconciliationStatus = pgEnum("reconciliation_status", RECONCILIATION_STATUSES);
export const investigationStatus = pgEnum("investigation_status", ["OPEN", "RESOLVED"]);

export const businesses = pgTable("businesses", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    // OPS users are not scoped to a business; OWNER users always are.
    businessId: uuid("business_id").references(() => businesses.id),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: userRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("users_owner_has_business", sql`${t.role} = 'OPS' OR ${t.businessId} IS NOT NULL`)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    currency: currency(),
    status: accountStatus("status").notNull().default("ACTIVE"),
    // Cache of SUM(ledger_entries.amount_cents); written in the same transaction as the entries.
    ledgerBalanceCents: cents("ledger_balance_cents").notNull().default(0),
    // The Increase account that originates this account's outbound payments (npm run increase:bootstrap).
    providerId: text("provider_id").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("accounts_business_currency_key").on(t.businessId, t.currency), usdOnly("accounts")],
);

export const cards = pgTable(
  "cards",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    status: cardStatus("status").notNull().default("ACTIVE"),
    last4: char("last4", { length: 4 }).notNull(),
    providerId: text("provider_id").unique(),
    createdAt: createdAt(),
  },
  (t) => [index("cards_account_id_idx").on(t.accountId), check("cards_last4_digits", sql`${t.last4} ~ '^[0-9]{4}$'`)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    type: transactionType("type").notNull(),
    status: transactionStatus("status").notNull(),
    // Magnitude of the movement; direction comes from the type and the ledger entries.
    amountCents: cents("amount_cents").notNull(),
    currency: currency(),
    provider: text("provider"),
    // The provider object this transaction tracks; see "Provider ids" in CLAUDE.md.
    providerObjectId: text("provider_object_id"),
    // Reversals and returns are new transactions pointing at the original.
    relatedTransactionId: uuid("related_transaction_id").references((): AnyPgColumn => transactions.id),
    // Who the money moved with, for display (e.g. a card purchase's merchant descriptor).
    counterparty: text("counterparty"),
    // Command idempotency (POST /funding, POST /payments) lives here only: the key is scoped to
    // the account and request_hash detects the same key reused with a different body.
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("transactions_account_created_idx").on(t.accountId, t.createdAt),
    uniqueIndex("transactions_account_idempotency_key").on(t.accountId, t.idempotencyKey),
    uniqueIndex("transactions_provider_object_type_key").on(t.provider, t.providerObjectId, t.type),
    index("transactions_related_transaction_id_idx").on(t.relatedTransactionId),
    // Reconciliation: a provider's transactions created in a window.
    index("transactions_provider_created_idx").on(t.provider, t.createdAt),
    check("transactions_amount_positive", sql`${t.amountCents} > 0`),
    check("transactions_idempotency_has_hash", sql`(${t.idempotencyKey} IS NULL) = (${t.requestHash} IS NULL)`),
    usdOnly("transactions"),
  ],
);

export const holds = pgTable(
  "holds",
  {
    id: id(),
    transactionId: uuid("transaction_id")
      .notNull()
      .unique()
      .references(() => transactions.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: holdKind("kind").notNull(),
    amountCents: cents("amount_cents").notNull(),
    status: holdStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at"),
    releasedAt: timestamptz("released_at"),
  },
  (t) => [
    // Available balance = ledger − SUM(active holds) per account.
    index("holds_account_active_idx").on(t.accountId).where(sql`${t.status} = 'ACTIVE'`),
    check("holds_amount_positive", sql`${t.amountCents} > 0`),
    check("holds_released_at_matches_status", sql`(${t.status} = 'ACTIVE') = (${t.releasedAt} IS NULL)`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .unique()
      .references(() => transactions.id),
    recipient: text("recipient").notNull(),
    // The recipient's bank account. The full number is stored only because the submitter must send
    // it to the provider; APIs, UI and logs show the last four digits.
    accountNumber: text("account_number").notNull(),
    routingNumber: text("routing_number").notNull(),
    description: text("description"),
    amountCents: cents("amount_cents").notNull(),
    currency: currency(),
    status: paymentStatus("status").notNull().default("PENDING"),
    provider: text("provider"),
    providerObjectId: text("provider_object_id"),
    // Outbox: a PENDING payment is the persisted intent; the worker's submitter claims it when
    // next_submit_at is due (while claimed, next_submit_at is the lease expiry).
    // Retry budget: claims so far.
    submitAttempts: integer("submit_attempts").notNull().default(0),
    // Fencing token: incremented on every claim; the submitter's later writes require it to match.
    submitClaimToken: integer("submit_claim_token").notNull().default(0),
    nextSubmitAt: timestamptz("next_submit_at").notNull().defaultNow(),
    lastSubmitError: text("last_submit_error"),
    // Set when the submitter stopped retrying with the outcome at the provider unknown; the payment
    // stays PENDING with its hold until a webhook (or Ops) says what happened.
    submitGaveUpAt: timestamptz("submit_gave_up_at"),
    // When the provider accepted the transfer.
    submittedAt: timestamptz("submitted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payments_account_created_idx").on(t.accountId, t.createdAt),
    uniqueIndex("payments_provider_object_key").on(t.provider, t.providerObjectId),
    // Submitter claim and the oldest-unsubmitted gauge: only rows still waiting to be submitted.
    index("payments_submit_due_idx").on(t.nextSubmitAt).where(sql`${t.status} = 'PENDING' AND ${t.submitGaveUpAt} IS NULL`),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
    check("payments_account_number_digits", sql`${t.accountNumber} ~ '^[0-9]{4,17}$'`),
    check("payments_routing_number_digits", sql`${t.routingNumber} ~ '^[0-9]{9}$'`),
    usdOnly("payments"),
  ],
);

export const externalEvents = pgTable(
  "external_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: externalEventStatus("status").notNull().default("RECEIVED"),
    // Retry budget: claims so far. Ops retry resets it.
    attempts: integer("attempts").notNull().default(0),
    // Fencing token: incremented on every claim (and Ops retry), never reset. A worker may only
    // update the event while the token still matches the one it claimed with.
    claimToken: integer("claim_token").notNull().default(0),
    // When the event is next due; while PROCESSING, when the worker's claim (lease) expires.
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    processedAt: timestamptz("processed_at"),
    correlationId: uuid("correlation_id").notNull(),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_events_provider_event_key").on(t.provider, t.externalEventId),
    // Worker claim: due rows that still need work, oldest first.
    index("external_events_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('RECEIVED', 'RETRY', 'PROCESSING')`),
    // Ops event viewer: newest first (keyset on received_at, id), all or by status; counts by status.
    index("external_events_received_idx").on(t.receivedAt, t.id),
    index("external_events_status_received_idx").on(t.status, t.receivedAt, t.id),
  ],
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: id(),
    externalEventId: uuid("external_event_id")
      .notNull()
      .references(() => externalEvents.id),
    isDuplicate: boolean("is_duplicate").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [index("event_deliveries_external_event_id_idx").on(t.externalEventId)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id),
    entryType: ledgerEntryType("entry_type").notNull(),
    // Signed: credit = positive, debit = negative.
    amountCents: cents("amount_cents").notNull(),
    currency: currency(),
    externalEventId: uuid("external_event_id").references(() => externalEvents.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ledger_entries_transaction_entry_type_key").on(t.transactionId, t.entryType),
    index("ledger_entries_account_created_idx").on(t.accountId, t.createdAt),
    check("ledger_entries_amount_nonzero", sql`${t.amountCents} <> 0`),
    usdOnly("ledger_entries"),
  ],
);

export const transactionEvents = pgTable(
  "transaction_events",
  {
    id: id(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    // 1, 2, 3 … per transaction.
    seq: integer("seq").notNull(),
    // 1, 2, 3 … per account, assigned under the account lock. Timeline and replay order by this,
    // never by occurred_at.
    accountSeq: bigint("account_seq", { mode: "number" }).notNull(),
    kind: transactionEventKind("kind").notNull(),
    amountCents: cents("amount_cents"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    ledgerDeltaCents: cents("ledger_delta_cents").notNull().default(0),
    ledgerBalanceAfterCents: cents("ledger_balance_after_cents").notNull(),
    availableAfterCents: cents("available_after_cents").notNull(),
    externalEventId: uuid("external_event_id").references(() => externalEvents.id),
    ledgerEntryId: uuid("ledger_entry_id").references(() => ledgerEntries.id),
    // Provider element behind this step (e.g. the settlement, reversal or return id), for reconciliation.
    providerRef: text("provider_ref"),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transaction_events_transaction_seq_key").on(t.transactionId, t.seq),
    uniqueIndex("transaction_events_account_seq_key").on(t.accountId, t.accountSeq),
    // Ops event viewer: the trace steps (and so the transactions) an external event caused.
    index("transaction_events_external_event_id_idx").on(t.externalEventId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    // Sanitized snapshots (ids, statuses, counts); never payloads or personal data.
    previousState: jsonb("previous_state"),
    newState: jsonb("new_state"),
    metadata: jsonb("metadata"),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

/**
 * One reconciliation of a provider's records against ours for a time window; also the job queue the
 * worker claims from, like external_events (attempts, claim_token fencing, lease in next_attempt_at).
 */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: id(),
    provider: text("provider").notNull(),
    windowStart: timestamptz("window_start").notNull(),
    windowEnd: timestamptz("window_end").notNull(),
    status: reconciliationRunStatus("status").notNull().default("PENDING"),
    // Retry budget: claims so far. Ops retry resets it.
    attempts: integer("attempts").notNull().default(0),
    // Fencing token: incremented on every claim (and Ops retry), never reset.
    claimToken: integer("claim_token").notNull().default(0),
    // When the run is next due; while RUNNING, when the worker's claim (lease) expires.
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    // Sanitized (safeErrorMessage).
    lastError: text("last_error"),
    matchedCount: integer("matched_count"),
    exceptionCount: integer("exception_count"),
    requestedBy: uuid("requested_by").references(() => users.id),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: createdAt(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    // One active run per provider: a second request (or a concurrent one) finds the first.
    uniqueIndex("reconciliation_runs_active_provider_key").on(t.provider).where(sql`${t.status} IN ('PENDING', 'RUNNING')`),
    // Worker claim: due runs that still need work.
    index("reconciliation_runs_due_idx").on(t.nextAttemptAt).where(sql`${t.status} IN ('PENDING', 'RUNNING')`),
    // Ops list (newest first) and each provider's latest finished run.
    index("reconciliation_runs_created_idx").on(t.createdAt, t.id),
    index("reconciliation_runs_provider_finished_idx").on(t.provider, t.finishedAt).where(sql`${t.status} = 'SUCCEEDED'`),
    check("reconciliation_runs_window_order", sql`${t.windowEnd} > ${t.windowStart}`),
  ],
);

/**
 * One comparison result of a run: our transaction and the provider's record side by side (either may
 * be missing). Ids, amounts and statuses only; never payloads.
 */
export const reconciliationRecords = pgTable(
  "reconciliation_records",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => reconciliationRuns.id),
    status: reconciliationStatus("status").notNull(),
    // Why, from a fixed set (e.g. "amount", "status", "reference", "within_grace").
    reason: text("reason"),
    transactionType: transactionType("transaction_type").notNull(),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    accountId: uuid("account_id").references(() => accounts.id),
    // The provider object (matched against transactions.provider_object_id) and the element behind it.
    externalId: text("external_id"),
    externalRef: text("external_ref"),
    internalAmountCents: cents("internal_amount_cents"),
    externalAmountCents: cents("external_amount_cents"),
    internalStatus: text("internal_status"),
    externalStatus: text("external_status"),
    // Set once, when Ops resolves the record's investigation; the comparison itself is never edited.
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("reconciliation_records_run_status_idx").on(t.runId, t.status),
    index("reconciliation_records_transaction_id_idx").on(t.transactionId),
  ],
);

/** An Ops case on one reconciliation record. Resolving never edits history (see CLAUDE.md, Reconciliation). */
export const investigations = pgTable(
  "investigations",
  {
    id: id(),
    recordId: uuid("record_id")
      .notNull()
      .unique()
      .references(() => reconciliationRecords.id),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    accountId: uuid("account_id").references(() => accounts.id),
    status: investigationStatus("status").notNull().default("OPEN"),
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => users.id),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    // The ADJUSTMENT the resolution posted, if any.
    adjustmentTransactionId: uuid("adjustment_transaction_id").references(() => transactions.id),
    createdAt: createdAt(),
    resolvedAt: timestamptz("resolved_at"),
  },
  (t) => [
    index("investigations_status_created_idx").on(t.status, t.createdAt, t.id),
    // One open case per transaction: overlapping runs report the same difference as separate records.
    uniqueIndex("investigations_open_transaction_key").on(t.transactionId).where(sql`${t.status} = 'OPEN'`),
    check("investigations_resolved_at_matches_status", sql`(${t.status} = 'OPEN') = (${t.resolvedAt} IS NULL)`),
  ],
);

export const investigationNotes = pgTable(
  "investigation_notes",
  {
    id: id(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("investigation_notes_investigation_created_idx").on(t.investigationId, t.createdAt),
    check("investigation_notes_body_length", sql`char_length(${t.body}) BETWEEN 1 AND 2000`),
  ],
);

/**
 * Outcome counters shared by the web and worker processes: each process buffers increments and
 * adds them here (`INSERT … ON CONFLICT DO UPDATE value = value + n`), outside business transactions.
 */
export const metricCounters = pgTable(
  "metric_counters",
  {
    name: text("name").notNull(),
    // jsonb compares by content regardless of key order, so one label set is one row.
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    value: bigint("value", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.name, t.labels] })],
);
