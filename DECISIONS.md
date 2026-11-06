# Decision log

## 2026-11-07 — Modular monolith: Next.js + one Node worker + Postgres

**Decision**
One TypeScript codebase deployed as two processes (Next.js web/API, worker) and one Postgres.

**Why**
The interesting problems are correctness and explainability, not scale. One codebase keeps the
domain shared between API, worker and tests; two processes keep webhook ingestion fast and let
processing retry independently.

**Alternatives**
Separate API service (Fastify) + web app; microservices.

**Tradeoff**
API and UI scale together; acceptable for a single-tenant sandbox.

## 2026-11-07 — Postgres is the queue (no Redis)

**Decision**
`external_events` doubles as the work queue; workers claim rows with
`FOR UPDATE SKIP LOCKED`.

**Why**
Persisting the raw event *is* the enqueue, so there is no window where an event is stored but
not queued (or queued but not stored). Retry state, errors and attempts are queryable by Ops.

**Alternatives**
BullMQ/Redis, SQS.

**Tradeoff**
Lower throughput ceiling than a dedicated queue; far above what this product needs.

## 2026-11-07 — Single-entry signed ledger with holds

**Decision**
Append-only `ledger_entries` per account (credit +, debit −, integer cents). Card
authorizations and pending payments are `holds`, not ledger entries. Available = ledger −
active holds.

**Why**
Matches how card networks work (authorization ≠ settlement) and makes the $80 → $65 case fall
out naturally: settlement posts −$65 and releases the $80 hold in one transaction.

**Alternatives**
Full double-entry with clearing accounts; debiting at authorization and crediting the
difference.

**Tradeoff**
No contra accounts, so provider-side clearing isn't modelled. Spec allows this; revisit if
multi-account flows appear.

## 2026-11-07 — Three-layer idempotency

**Decision**
`UNIQUE(provider, external_event_id)` for events, `Idempotency-Key` with a unique constraint
for commands, `UNIQUE(transaction_id, entry_type)` for ledger entries.

**Why**
Each layer catches a different failure: provider retries, client retries, and our own worker
re-running a half-processed event. Constraints, not application checks, so races are harmless.

**Alternatives**
Application-level "check then insert"; distributed locks.

**Tradeoff**
Slightly more schema; none in behaviour.

## 2026-11-07 — Stripe test mode for funding

**Decision**
Funding is a Stripe PaymentIntent confirmed with a test payment method; we consume
`payment_intent.succeeded` / `payment_intent.payment_failed`, verified with `Stripe-Signature`.

**Why**
Simplest real sandbox money-in flow. PaymentIntents and balance transactions can be listed for
reconciliation. Stripe documents duplicate and unordered delivery, which exercises our
idempotency for real.

**Alternatives**
Stripe top-ups, Treasury (platform setups, more onboarding).

**Tradeoff**
Funding is a card payment rather than a bank transfer; fine for a sandbox.

## 2026-11-07 — Increase sandbox for card lifecycle and outbound payments

**Decision**
Increase is the second provider: virtual card authorizations/settlements/reversals/expiry via
its sandbox simulations, and outbound ACH transfers (submit → settle / return).

**Why**
Self-serve sandbox via API, a simulation endpoint for every lifecycle step we need (including
settling for a different amount than authorized), list endpoints with filters for
reconciliation, and `Idempotency-Key` support. Stripe Issuing test mode may need to be
enabled per account; Increase removes that dependency.

**Alternatives**
Stripe Issuing (access unverified), Unit, Modern Treasury, Dwolla (batch-only simulation),
Moov (slow test ACH), Column; our own card simulator.

**Tradeoff**
Increase webhooks are thin (`*.created` / `*.updated`) so the worker re-fetches the object, and
sandbox webhooks are not retried, so we also poll the Events API as a backstop. Demo failure
cases (dropped / duplicated / delayed delivery) come from a test-only fault injector at
ingestion, not from the provider.

## 2026-11-07 — Worker claims events with a lease

**Decision**
Each pass claims one event: `UPDATE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED)` sets
`PROCESSING`, increments `attempts` (retry budget) and `claim_token` (fencing token), and sets
`next_attempt_at` to a lease expiry (120 s, longer than a 10 s fetch plus one processing
transaction). The handler's `fetch` runs after that commit with no transaction open; `apply`
runs in a transaction that re-reads and locks the event row only if it is still `PROCESSING`
with the same `claim_token`, and marks it `PROCESSED` in that same transaction. Expired
`PROCESSING` rows are claimable again. Failures back off 5 s doubling, capped at 15 min; after
10 attempts (≈36 min of retries) the event is `FAILED`.

**Why**
A worker that dies after claiming must not strand the event, and a worker whose lease expired
must not apply effects after another worker has taken over. A separate `claim_token` keeps
fencing correct when Ops resets `attempts` for a manual retry. One event per claim means a
poison event can't burn the attempts of others claimed alongside it. Crash loops still end: an
event claimed more than 10 times is marked `FAILED` without running again. Event types without
a handler are retried, not ignored, so a missing handler shows up as `FAILED` instead of money
silently not moving; only an explicit per-provider ignore list yields `IGNORED`.

**Alternatives**
Hold the row lock for the whole processing transaction and skip `PROCESSING` (no stuck rows, but
claimed work is invisible to Ops and a batch claim can't be separated from processing); a
`claimed_by` column plus a separate lease timestamp.

**Tradeoff**
An event whose worker died waits up to the lease length before being retried; one claim
round-trip per event instead of per batch.

## 2026-11-07 — Schema conventions

**Decision**
Postgres enums for every status and type; `transactions.amount_cents` (and holds, payments) is
a positive magnitude, while `ledger_entries.amount_cents` is signed; ledger entry types carry a
fixed direction checked in `domain/ledger` (only `ADJUSTMENT` may be either sign); trace events
use a small set of kinds (`STATUS_CHANGED`, `HOLD_CREATED`, `HOLD_RELEASED`, `HOLD_EXPIRED`,
`LEDGER_POSTED`) with `from_status`/`to_status` carrying lifecycle detail; one account per
`(business_id, currency)`; seed rows use fixed ids so re-running is a no-op. Command
idempotency keys live only on `transactions` (`UNIQUE(account_id, idempotency_key)` plus
`request_hash`). Each transaction type posts one ledger entry type; a correction is its own
`ADJUSTMENT` transaction.

**Why**
Enums make illegal values unrepresentable and adding values is a backward-compatible migration.
Keeping sign only in the ledger means there is one place that says which way money moved.

**Alternatives**
Text columns with check constraints; signed transaction amounts.

**Tradeoff**
Removing or renaming an enum value needs a multi-step migration.

## 2026-11-07 — Late settlement posts even if the hold already closed

**Decision**
A card settlement whose hold already EXPIRED (or was RELEASED) still posts its ledger debit; the
trace gets a `SETTLED_AFTER_HOLD_CLOSED` row after `LEDGER_POSTED`. Settlement makes all state
changes (entry, cached balance, hold status) before writing any trace row, so every trace row
carries balances that were true once the transaction committed.

**Why**
Late capture is normal for cards: the provider has moved the money, so refusing the debit would
leave our ledger wrong and the event stuck in FAILED. Writing trace rows after the state changes
avoids showing an intermediate available balance (e.g. $500 between a hold release and its
debit) that the account never had.

**Alternatives**
Reject and retry until Ops intervenes; a note column on `LEDGER_POSTED` instead of a separate
kind.

**Tradeoff**
Available can briefly have been higher than the eventual debit allows (between expiry and late
capture); the trace makes that visible instead of hiding it.
