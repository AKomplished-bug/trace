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

## 2026-11-07 — Funding calls Stripe from the API request, after commit

**Decision**
`POST /api/funding` commits the `PENDING` FUNDING transaction and its first trace row, then
creates and confirms the PaymentIntent in the same request (10 s timeout, SDK retries off) and
stores its id as `provider_object_id`. Stripe gets the idempotency key `funding-<transaction id>`,
not the client's key.

**Why**
The owner gets the PaymentIntent id (or a clear error) in the response, and no network call runs
inside the DB transaction. The pending transaction is the persisted intent: a client retry with
the same `Idempotency-Key` finds it and repeats the Stripe call with the same Stripe key, so a
timeout that did create a PaymentIntent returns that one rather than charging twice. Our key is
per transaction because client keys are only unique per account, while Stripe's are per Stripe
account.

**Alternatives**
A worker outbox submitter, as CLAUDE.md prescribes for outbound calls: the API only writes the
intent and the worker calls Stripe with backoff.

**Tradeoff**
Retries are client-driven. If Stripe did create the PaymentIntent (the response was lost to our
timeout, or storing its id failed), its webhook still credits the transaction: the handler finds
it through the PaymentIntent's `transaction_id` metadata (see below). If Stripe never created
one and the client never retries, the funding stays `PENDING` with no PaymentIntent — no money
moved, but the row is stuck; those rows are visible (`provider_object_id IS NULL`) and the next
step is a worker submitter or sweep that retries or expires them. Until then this is a known
exception to the outbox rule.

## 2026-11-07 — A failed Stripe call leaves funding PENDING, not FAILED

**Decision**
A timeout or Stripe error keeps the transaction `PENDING`; the error is logged with the Stripe
request id and the client gets `502 provider_unavailable` telling it to retry with the same key.
A card decline is not an error: the declined PaymentIntent's id is stored and its
`payment_intent.payment_failed` webhook moves the transaction to `FAILED`.

**Why**
After a timeout the outcome at Stripe is unknown; marking `FAILED` could contradict a payment
that succeeded. Only Stripe's final word, via the webhook, changes the status, so there is one
writer of funding status transitions.

**Alternatives**
`FAILED` on any error (simple, but wrong when the charge went through); an error column on
`transactions`.

**Tradeoff**
The API never shows `FAILED` directly, even for a decline it saw; the client sees it once the
webhook is processed.

## 2026-11-07 — Funding outcomes trust the fetched PaymentIntent; a mismatch goes to Ops

**Decision**
`payment_intent.succeeded` / `payment_intent.payment_failed` map to internal `FUNDING_CONFIRMED` /
`FUNDING_FAILED`. The handler's `fetch` re-retrieves the PaymentIntent and `apply` acts on that
object: confirmation needs status `succeeded`, currency USD and `amount_received` equal to our
`amount_cents`, then moves `PENDING → SETTLED` (`SETTLED`, like card settlement: the money has
landed) and posts `FUNDING_CREDIT` with `provider_ref` = the charge id. If `amount_received`
or currency differs, nothing is posted: the handler throws a `PermanentEventError` and the event
is `FAILED` at once, with both values in `last_error`. A status that isn't final yet (e.g.
`processing`) retries instead. A `payment_failed` whose PaymentIntent has since succeeded is a
no-op.

**Why**
We create and confirm the PaymentIntent in one call, so a different amount means something
outside our flow changed it; crediting an amount we can't explain is worse than a delayed credit
that Ops resolves with an `ADJUSTMENT`. Re-fetching means a stale or replayed payload can't move
money.

**Alternatives**
Post the provider amount and flag the transaction (the card-settlement approach, where differing
amounts are normal).

**Tradeoff**
The customer's money is at Stripe but not in their balance until Ops resolves it. Retrying
wouldn't help — the amounts won't change — so failing at once gets it to Ops ~36 minutes sooner.

## 2026-11-07 — Funding webhooks find their transaction by PaymentIntent id, then by metadata

**Decision**
The handler looks the FUNDING transaction up by `provider_object_id`. If that misses, it uses
the fetched PaymentIntent's `metadata.transaction_id` (set when we create it) and, under the
account lock, stores the PaymentIntent id on that transaction if it has none, then settles or
fails it as usual. Outcomes:
- the metadata names a transaction that already tracks a different PaymentIntent → permanent
  `FAILED` for Ops (a second PaymentIntent, e.g. a client retry after Stripe's 24 h idempotency
  window);
- no (valid) metadata → permanent `FAILED`: we didn't create it (e.g. made in the dashboard), so
  there is no account to credit;
- metadata names a transaction that isn't there → retry, then `FAILED`.

**Why**
The API stores the PaymentIntent id after Stripe answers. If the answer is lost (our 10 s
timeout, a dropped connection) or the id write fails, Stripe has charged the card but our row
doesn't know the PaymentIntent; without the fallback the event would retry until `FAILED` and
the customer would be charged but never credited unless they happened to retry. The metadata
comes from the PaymentIntent we re-fetch from Stripe, so it's as trustworthy as the amount.

**Alternatives**
Retry until the client retries and stores the id (the gap above); a reconciliation sweep that
links orphans later.

**Tradeoff**
Two ways to find a transaction instead of one. The metadata path only links a transaction with
no PaymentIntent yet, so it can't move one onto another's payment.

## 2026-11-07 — Demo auth: HMAC-signed session cookie

**Decision**
`/login` lists the seeded users; picking one (no password — it's a sandbox) sets
`trace_session = base64url(claims).base64url(HMAC-SHA256(SESSION_SECRET))`, HttpOnly,
SameSite=Lax, Secure in production, 12 h. Claims are `{ userId, role, accountId, expiresAt }`,
with the owner's account resolved from the database at sign-in. Every API handler calls
`requireOwner(request)` / `requireOps(request)` (`src/app/api/session.ts`) first; they verify
the signature only and return a 401/403 Response otherwise. Owner reads and `POST /api/funding`
use the claim's `accountId`, never an id from the client. The proxy (`src/proxy.ts`) applies the
same check in front of `/api/ops/**`, `/ops/**` and every page (signed-out pages redirect to
/login), reading only `SESSION_SECRET` (`sessionConfig()`), so a missing provider key can't break
/login; the full config still fails fast at startup. Pages call `requirePageSession`, which also
re-reads the user for the names the shell shows. Login and logout accept only JSON or a
urlencoded form, and refuse a request whose `Origin` is present and isn't this host (login
CSRF). In production the `.env.example` `SESSION_SECRET` is refused at startup.

**Why**
No session table or identity provider to run, the cookie can't be forged or re-pointed at
another account without the secret, and API auth needs no database round-trip, so handlers stay
testable with a plain `Request`. SameSite=Lax doesn't stop another site from signing a visitor
in as someone else with a cross-site form post; the Origin check does.

**Alternatives**
A sessions table (revocable, one more read per request); re-reading the user on every API call;
CSRF tokens on the login form; NextAuth or another provider (setup a sandbox doesn't need).

**Tradeoff**
A session can't be revoked or re-scoped before it expires except by rotating `SESSION_SECRET`;
acceptable for fixed demo users.

## 2026-11-07 — Owner read side: snapshot reads, keyset pages, formula from the domain

**Decision**
Reads that span tables (balance, transaction detail, timeline — and detail + timeline together
on the transaction page) run in one `REPEATABLE READ, READ ONLY` transaction, so ledger, holds
and trace come from the same commit and never take locks. The timeline is ordered by
`account_seq`, like replay; `seq` is returned alongside. `GET /api/transactions` pages newest
first on `(created_at, id)` with an opaque cursor that carries `created_at` at microsecond
precision (rows created in one database transaction share `now()`). The balance explanation's
terms, operators and formula string live in `domain/ledger/balance.ts` (`BALANCE_TERMS`,
`BALANCE_FORMULA`) and the API returns them; the UI only renders. Another business's
transaction answers 404, the same as a missing one. The UI signs an amount only once it has
posted to the ledger; an active hold shows "on hold", and money that never moved (failed
funding, expired or released authorization) is struck through with its status.

**Why**
Separate autocommitted reads could see a settlement's debit without its hold release and show
an available balance that never existed. Offset paging skips or repeats rows as new
transactions arrive; a millisecond cursor would skip ties. Keeping the formula in the domain
means the explanation can't drift from the calculation. A "−$80.00" on an authorization that
expired would tell the owner money left that never did.

**Alternatives**
Locking the account for reads; offset pagination; paging on the trace's `account_seq`
(transactions without trace rows yet would have no position).

**Tradeoff**
A snapshot transaction per read costs a round-trip for BEGIN/COMMIT. The list relies on
`transactions_account_created_idx` (account_id, created_at); the id tie-break and the type /
status filters are applied on top of it, fine at sandbox volumes.

## 2026-11-07 — Card events: re-fetch the card payment and apply only its new elements

**Decision**
`card_payment.created` and `card_payment.updated` share one handler. `fetch` re-reads the whole
`card_payment` (Increase webhooks are thin); `apply` locks the account, re-reads the purchase,
collects the element ids already applied (the purchase's `transaction_events.provider_ref`s and
its CARD_REVERSAL `provider_object_id`s) and applies the rest in Increase's element order, all in
the event's transaction. Element ids, not event ids, are the unit of idempotency.

**Why**
Every update carries every step so far, so an event can't say "this is the settlement". Diffing
by element id makes a duplicate, a later event for the same state, an older snapshot, and two
workers racing on created + updated all converge on one effect per element; the account lock
serializes them. A refund also has `UNIQUE(provider, provider_object_id, type)` behind it.

**Alternatives**
Map event → one element (impossible with thin events); store a per-card-payment "last applied
element index" (breaks if Increase ever inserts or reorders elements).

**Tradeoff**
One extra indexed read of the purchase's trace per event. A step we can't place (settlement,
reversal or expiration with no recorded authorization, e.g. a force-posted settlement; an
unlinked card) retries and ends `FAILED` for Ops, per the out-of-order rule.

## 2026-11-07 — An approved authorization is recorded even above available balance

**Decision**
An authorization element always creates the AUTHORIZED purchase and ACTIVE hold, even when it
takes available below zero; the trace then gets `HOLD_EXCEEDS_AVAILABLE` after `HOLD_CREATED`
and the worker logs `authorized_over_available`.

**Why**
Increase has already approved it (sandbox simulations, and real authorizations without
real-time decisions), so the merchant will settle regardless. Refusing to record it would make
our available balance wrong and hide the exposure; the flag makes it visible instead.

**Alternatives**
Decline in real time via Increase real-time decisions (the right production answer, and a
separate integration); fail the event to Ops.

**Tradeoff**
Available can be negative. Until real-time decisions exist, nothing stops the card spending
money the ledger doesn't have — Increase only checks its own sandbox account balance.

## 2026-11-07 — Card reversal vs refund; purchase status after each

**Decision**
Following Increase's lifecycle guide, a `card_reversal` cancels (part of) an authorization and
never moves settled money; a `card_refund` is money back. So: a full reversal of an AUTHORIZED
purchase releases the hold and moves it to `REVERSED` (existing enum value, no ledger entry); a
reversal or expiration of a purchase that is no longer AUTHORIZED is a no-op. Each refund is a
new `CARD_REVERSAL` transaction (`SETTLED`, ledger credit, keyed by the refund element id) linked
to the purchase, which stays `SETTLED`. A settlement after a void or expiry still posts (late
capture). The owner API's `reverse` simulates a reversal before settlement and a refund after.

**Why**
The purchase did settle; partial refunds stack, so no single purchase status ("REVERSED" after
the first $20 of $65?) would be true. The reversals point at it, and the money graph nets them.

**Alternatives**
Mark the purchase `REVERSED` once refunds cover it; a `VOIDED` status for authorization voids
(`REVERSED` already says "never completed").

**Tradeoff**
"Fully refunded" is derived (sum of linked reversals), not a status.

## 2026-11-07 — Refunds on their own card payment are credited unlinked

**Decision**
A `card_refund` on a card payment that has no purchase of ours is still credited, as a
`CARD_REVERSAL` with `related_transaction_id` null (worker logs `unlinked_refund`).

**Why**
Increase's lifecycle guide says Visa doesn't tie refunds to the original payment, so a refund
can arrive on its own `card_payment` with no authorization. The money has moved; retrying until
`FAILED` would leave the ledger short for every such refund.

**Alternatives**
Retry → Ops (the settlement-without-authorization rule); guess the purchase by merchant and
amount.

**Tradeoff**
Some refunds show no link to their purchase. Linking them is reconciliation / Ops work.

## 2026-11-07 — Card lifecycle shapes we don't model fail to Ops

**Decision**
Partial authorization reversals, increments, fuel confirmations, card financials, refund
authorizations, a second authorization or a second settlement (multi-capture) on one card
payment, and non-USD or non-positive amounts throw `UnsupportedCardElementError`
(`PermanentEventError`): the event is `FAILED` at once and nothing from that snapshot is applied.
Declines, 3DS authentications, card validations and balance inquiries are skipped (no money, no
hold).

**Why**
Each needs a model change (hold amounts that shrink or grow; more than one settlement entry per
purchase, which `UNIQUE(transaction_id, entry_type)` forbids). Guessing would post the wrong
amount; failing at once gets it to Ops instead of burning 36 minutes of retries.

**Alternatives**
Adjust `holds.amount_cents` in place for partial reversals and increments; one CARD_PURCHASE
child transaction per capture.

**Tradeoff**
Hotel-style partial reversals and multi-capture are common in production; the sandbox demo only
drives full voids and single settlements.

## 2026-11-07 — Card simulations call Increase from the API; state changes only via the webhook

**Decision**
`POST /api/cards/:id/{authorize,settle,reverse,expire}` (owner only) reads the card and purchase,
calls the matching Increase sandbox simulation with no transaction open (10 s timeout, SDK
retries off), and returns `202` with what was requested. It writes nothing: the result arrives as
a `card_payment.*` webhook and the worker applies it. Settle and reverse re-fetch the card payment
to find Increase's pending transaction / settlement transaction ids rather than storing them.
Timeouts and 5xx are `502 provider_unavailable`; Increase refusing the step (4xx) is
`422 provider_rejected`. Steps on a purchase re-fetch its card payment first: one on a different
card is a 404, and `reverse` with `amountCents` before settlement is refused
(`422 partial_reversal_not_supported`) because the worker can't apply a partial void (see below).
The adapter always targets the sandbox environment.

**Why**
One path changes card state, the same one real card activity takes, so the demo exercises
ingestion, idempotency and the worker for real. Re-fetching avoids new columns for ids we only
need to simulate.

**Alternatives**
Apply the simulation result directly in the API (two writers of card state); store
`pending_transaction_id` and settlement transaction ids on our rows.

**Tradeoff**
Settle and reverse are two Increase calls. After a timeout the outcome at Increase is unknown,
so the caller should check activity before retrying. Sandbox webhooks are not retried, so until
the Events API backstop lands a webhook missed while the app is down leaves the step unapplied.

## 2026-11-07 — Increase webhooks: Standard Webhooks, verified by hand

**Decision**
`verifyWebhook` checks `webhook-signature` (`v1,` + base64 HMAC-SHA256 of
`${webhook-id}.${webhook-timestamp}.${body}`), keyed with `INCREASE_WEBHOOK_SECRET` as given,
accepting any one of several space-separated signatures, with a constant-time compare and a
5-minute timestamp window. The stored event type is the Increase event `category`.

**Why**
That is the scheme Increase documents (and its SDK's `unwrap` uses the raw secret as the key the
same way). Doing it in ~15 lines keeps the check explicit and testable without an SDK client.

**Alternatives**
The SDK's `events.unwrap` (needs a configured client); the `standardwebhooks` library directly.

**Tradeoff**
Our own crypto code to maintain; covered by tests for valid, tampered, stale, future, wrong-secret,
rotated and malformed signatures.

## 2026-11-07 — An unmodelled element blocks its whole card payment until Ops resolves it

**Decision**
When a card payment contains an element we don't model (see above), the event fails permanently
and nothing from that snapshot is applied — including later, modelled elements such as the
settlement of the remaining amount. Every later event for that card payment fails the same way,
because each re-fetch still contains the element. The sandbox API refuses the one such step it
could otherwise create (a partial void before settlement).

**Why**
Elements apply in order inside one transaction; skipping one and applying the rest would post
effects on top of a hold or balance we know is wrong, with no record of the gap. A loud, stuck
card payment is safer than a quietly wrong ledger.

**Alternatives**
Skip unmodelled elements and apply the rest (silent drift); apply everything before the
unmodelled element and stop there (partial state, harder to reason about on retry).

**Tradeoff**
Until Ops resolves it, the ledger and Increase disagree for that card payment: Increase has moved
(or held) money that our ledger and available balance don't show. Resolution needs the Ops tools
— a manual `ADJUSTMENT` with an audit note, then marking the event resolved — which come with the
Ops work; today the only signal is the `FAILED` event and its `UnsupportedCardElementError`.

## 2026-11-07 — Replay folds the recorded trace and checks every step against it

**Decision**
Replay (`domain/replay`) is a pure fold: `state = initial; for row in trace: state = apply(state,
row)`, with state = ledger, available, holds by id and status, transaction statuses. Each step
yields before / after / the row / an explanation key, and is compared with the row's stored
`ledger_balance_after_cents` / `available_after_cents`; the result is `consistent` plus the first
divergence. `GET /api/transactions/:id/replay` and the transaction page read it in the same
`READ_SNAPSHOT` as the detail and timeline; nothing is written or locked. Two modes:
- **Account replay**: every row on the account in `account_seq` order from zero. Its final state
  must equal the cached `ledger_balance_cents`, `SUM(ledger_entries)`, available and the set of
  ACTIVE holds (`accountMismatches`). The integration tests' `balances()` invariant and the
  `/balance` page both run it.
- **Transaction replay**: only the transaction's rows. Other transactions' rows interleave on the
  account, so the replay can't simply run on from the first row: the stored running balances
  include everyone's effects. Each row is checked on its own delta instead — the start state is
  the balances recorded by the account's previous row (`account_seq − 1`, zero for the first),
  and whenever there is a gap in `account_seq` since this transaction's previous row, the
  replayed balances are moved to that previous row's recorded balances and the difference is
  reported as the step's `otherActivity`. So each step checks
  `recorded after == recorded before + this row's own effect`, however much happens in between.
  Consecutive rows (no gap) carry on from the replayed state, so one bad row flags only its own
  step rather than being absorbed.

Available before a row is therefore never recomputed as "ledger − this transaction's holds": it
is the account's recorded available just before the row, which already includes every other
transaction's active holds. Replay carries available as a number and moves it by each row's own
effect (hold created −amount; ledger posted ±delta; hold released/expired +amount).

A settlement is one database transaction that releases the hold and posts the entry, then writes
LEDGER_POSTED and HOLD_RELEASED with the final balances (money rules 5 and 10). Replay pairs a
LEDGER_POSTED with a HOLD_RELEASED of the same transaction at `account_seq + 1` **that recorded
the same balances**, and applies the release with the posting (`settlement_released_hold`), so the
steps read 500/500 → 500/420 → 435/435 → 435/435 as the account actually was; the paired
HOLD_RELEASED changes nothing. A post and a release in two separate database transactions also
sit at n, n + 1 but record different available balances, so they replay as a plain posting and a
plain release. A SETTLED_AFTER_HOLD_CLOSED (late capture) releases nothing. If a pairing were ever
wrong, the balances wouldn't match and the replay would say so. In a transaction replay each
LEDGER_POSTED's delta is also compared with the amount of the ledger entry it points at
(`reason: "ledger_entry"`), so drift between the trace and the ledger shows on the transaction,
not only in the account check.

**Why**
"Replayed == stored" (CLAUDE.md) becomes something the owner can see per transaction and a test
after every integration test, and tampering or a buggy writer surfaces at the exact step.
Starting from the previous row rather than `first.after − first.delta` lets the first row be
checked too; deriving it from the first row would make that step match by construction.

**Alternatives**
Recompute from ledger entries and holds tables instead of the trace (checks nothing about the
trace); replay a transaction in isolation from zero (wrong once anything interleaves); group rows
by database transaction (we don't record one).

**Tradeoff**
The account replay reads the whole trace on every `/balance` view — an ordered scan of
`transaction_events_account_seq_key`, fine at sandbox volume; at scale it would run from a
checkpoint (e.g. a periodic snapshot of balances and active holds) or as a background check.
Only the first divergence is reported in the API's `divergence` (each step still has `matches`).
A mismatch is logged (`replay_mismatch` with account, transaction, step and reason) by the
service readers, so the API, the transaction page and `/balance` all report it from one place
(`reportReplayMismatch`), which is where a counter goes once the metrics work lands. Owners see a
plain sentence; ids and figures stay in the log.

Pairing by adjacency and equal balances is a heuristic for "written in the same database
transaction". It can't tell a settlement row tampered to exactly the two-transaction value from a
genuine post-then-release. **Proposed long-term fix:** record the database transaction on every
trace row (e.g. a `db_txid` column defaulting to `txid_current()`, added nullable and backfilled
as unknown), group rows by it, and check each group's final balances; pairing, the effect-order
rule (money rule 10) and the settlement exception then become checks rather than conventions.

## 2026-11-07 — Money graph: derived from the trace, plain DOM, links to records

**Decision**
`moneyGraph` (`domain/replay/graph.ts`) derives nodes and edges for one transaction: one
external node per provider element (`provider_ref`, else external event), the hold, the ledger
entry, the resulting balance and linked transactions; edges `created`, `closed_by`, `posted`,
`updated`, `reserves`, `restored`, `original_of`, `followed_by`. Nodes carry ids only (trace row,
hold, ledger entry, our and the provider's event ids) — never `external_events.payload`. The page
renders it as an ordered column of nodes with labelled arrows (no graph library); nodes link to
`#step-…` / `#ledger-…` / `#event-…` anchors, which highlight and open the matching technical
details, or to the linked transaction. The raw timeline stays on the page.

**Why**
Our graphs are short chains (authorization → hold → settlement → ledger entry → balance), so a
column reads better on a phone than a laid-out graph and needs no dependency.

**Alternatives**
A graph layout library (dagre, react-flow); SVG with computed positions.

**Tradeoff**
Edges that skip a node are listed on the node as text rather than drawn.

## 2026-11-07 — Available balance: the exact formula

**Decision**
`Available = Ledger balance − Pending card holds − Pending payments`, where ledger balance is
`SUM(ledger_entries.amount_cents)` (cached on `accounts`), pending card holds is the sum of ACTIVE
`CARD_AUTHORIZATION` holds and pending payments the sum of ACTIVE `PENDING_PAYMENT` holds. There
are no "available credits" or "other reserved funds" terms (spec §12, §22.7): nothing else
reserves or adds to available in this model, so those lines would always be $0. Available can be
negative (an authorization approved above available). The terms, operators and formula string
live in `domain/ledger/balance.ts`; `/balance` and the dashboard render them, and `/balance`
lists the ACTIVE holds behind each pending term with a link to its transaction.

**Why**
The spec asks for the formula of the chosen accounting model to be written down rather than
hard-coded in the UI.

**Alternatives**
Showing always-zero lines for the spec's extra terms.

**Tradeoff**
Adding a new kind of reservation means a new hold kind and a new term in `BALANCE_TERMS`.

## 2026-11-07 — Outbound payments go through an outbox on `payments`, sent by the worker

**Decision**
`POST /api/payments` only writes, in one DB transaction under the account lock: the
`OUTBOUND_PAYMENT` transaction (`PENDING`), its `payments` row, an ACTIVE `PENDING_PAYMENT` hold for
the amount and the trace (`HOLD_CREATED`, then `STATUS_CHANGED → PENDING`). The PENDING payment row
is the persisted intent. The worker's submitter (`src/worker/payment-submitter.ts`) claims one due
payment per pass — `UPDATE … WHERE id = (SELECT … WHERE status = 'PENDING' AND next_submit_at <=
now() … FOR UPDATE SKIP LOCKED)`, bumping `submit_attempts` (retry budget) and `submit_claim_token`
(fencing) and pushing `next_submit_at` out by a 120 s lease — then, with no transaction open, calls
Increase `POST /ach_transfers` with `Idempotency-Key: payment-<payment id>`. It records the transfer
id and moves the payment and its transaction `PENDING → SUBMITTED` in a transaction that locks
account → payment and checks the claim token. The worker loop takes one event and one payment per
pass. Every minute it logs `pending_payments` and `oldest_unsubmitted_payment_age_seconds`, and each
submission logs its `queue_age_seconds`.

**Why**
No network call in the request or under a lock. Retries come from a background job with backoff,
and a crash at any point (before the call, after it, or before storing the id) only means the next
claim repeats the call with the same key. Increase guarantees at most one object per key and
returns the first transfer, so the money can't go out twice
(https://increase.com/documentation/idempotency-keys). The key is per payment, not the client's
key, because client keys are only unique per account. Alerting on the age of the oldest unsent
payment catches a stuck submitter.

**Alternatives**
Call Increase in the request after commit, the way funding does. A generic claim helper shared with
`external_events`. A separate `payment_outbox` table.

**Tradeoff**
The claim is a parallel twenty lines of SQL, not a shared helper: the two queues mean different
things by "claimable" (events have a `PROCESSING` status, while a payment's status is a business
status that stays `PENDING` during the lease) and use different columns. A generic helper would
have to build table and column identifiers dynamically. The backoff (`backoffMs`) and budget (10)
are shared. The owner sees `PENDING` until the submitter runs, usually within a second.

## 2026-11-07 — The funds check runs under the account lock; a refused payment stores nothing

**Decision**
After the idempotent insert, `createPayment` computes available (ledger − active holds) while
holding the account lock it took first. If available is below the amount it throws
`InsufficientFundsError` (422 `insufficient_funds`) and the whole transaction rolls back, including
the transaction row that carries the Idempotency-Key. An account with no linked Increase account is
refused the same way (409 `account_not_linked`).

**Why**
Every writer of ledger entries and holds takes that lock first, so available can't change between
the check and the hold insert. Concurrent payments queue on it, and only those that fit succeed
(tested with eight concurrent payments against $500). Storing nothing means a retry with the same
key, made after funds arrive, goes through.

**Alternatives**
A `CHECK`/trigger on available balance; `SERIALIZABLE` isolation with retries; storing the 422
against the key so a retry replays the refusal.

**Tradeoff**
Payments on one account are serialized; that's the account's money, so it should be.
`request_hash` is an unsalted SHA-256 of a low-entropy body that includes the account number, so it
could be brute-forced back to it; it stays on our row and is never returned or logged. A card
authorization that Increase approves can still push available negative afterwards (see the card
decision); the payment check can't prevent that.

## 2026-11-07 — `SUBMITTED` status and a `SUBMITTED_TO_NETWORK` trace step

**Decision**
`SUBMITTED` is added to both `transaction_status` and `payment_status` (they always move together,
in one statement pair). It means Increase accepted the transfer. Increase's own `submitted` (it sent
the transfer to FedACH) is a no-money trace row of a new kind, `SUBMITTED_TO_NETWORK`, not a status.
The enum values have their own migration (0002), before the columns that use them (0003).

**Why**
The lifecycle the owner sees is Pending → Submitted → Completed / Returned. Keeping the transaction
status equal to the last `STATUS_CHANGED.to_status` keeps replay simple. Settlement is
`settlement` becoming non-null while Increase's status stays `submitted`
(https://increase.com/documentation/api/ach-transfers#the-ach-transfer-object), so FedACH
submission is a step and not a state of ours.

**Alternatives**
Keep the transaction `PENDING` until it completes (the spec's two-state lifecycle) and put
`SUBMITTED` on `payments` only; a `PROCESSING`-style outbox status.

**Tradeoff**
One more status in the activity filter and labels.

## 2026-11-07 — Submission failures: a first-attempt refusal releases the hold; unknown gives up, PENDING

**Decision**
- Timeout, 5xx or 429, Increase 401/403/409 (other than a reused key), or our own failure after
  the call → retry with backoff (5 s doubling, capped at 15 min), hold kept, `last_submit_error`
  stored as a sanitized message.
- Increase 4xx **on the first attempt**, other than 401/403/409 → `FAILED`, hold released
  (`HOLD_RELEASED` then `STATUS_CHANGED → FAILED`), no ledger entry.
- Anything whose outcome is unknown → the submitter **gives up**: a 4xx other than 401/403/409 on a
  later attempt, a 409 `idempotency_key_already_used_error`, 10 failed attempts (401/403/409
  included), or a claim seen more
  than 10 times (crash loop). The payment stays `PENDING` with its hold, `submit_gave_up_at` is set,
  which removes it from the claim query and its partial index, and the trace gets a `STATUS_CHANGED
  PENDING → PENDING` row ("Couldn't confirm the payment was sent"; no new trace kind). The worker's
  backlog log line reports `given_up_payments`.
- Giving up isn't final: a later `ach_transfer.*` webhook finds the payment by our `payment-<id>`
  key and applies the normal steps — a live transfer is accepted and then completes or returns, and
  a rejected or canceled one moves it to `FAILED` and releases the hold.
- A live transfer for a payment that is `FAILED` (Increase refused it, so the hold is released) is
  a permanent event failure for Ops (`PaymentTransferMismatchError`) and changes nothing.

**Why**
After a timeout the outcome at Increase is unknown: it may have created the transfer and we lost
the answer. Releasing the reservation could then let the owner spend money that has already left.
Increase replays the original response for a repeated key, so a 4xx on the *first* attempt is a
definite "not created". After an earlier timeout it isn't: that request may still have created it.
401/403/409 are our credentials, permissions or a conflict, never proof either way, and they can
pass (a rotated key, a transient conflict), so they get the same budget as a timeout instead of
giving up at once; they never release the hold. Leaving the
payment `PENDING` rather than `FAILED` keeps one state machine: the provider's word, by webhook,
still moves it, so there's no `FAILED → SUBMITTED` edge to invent.

**Alternatives**
Mark it `FAILED` with the hold kept (the first version; a late webhook then had nowhere to go);
release on exhaustion, which overstates available if the money went out; reconcile through
`GET /ach_transfers?idempotency_key=` before giving up.

**Tradeoff**
A given-up payment reserves its funds until a webhook arrives or Ops resolves it (see the Ops
payment actions decision). Sandbox webhooks aren't retried, so without the Events API backstop that
can be a while. The signals are the log line, `submit_gave_up_at`, the trace row and `/ops/payments`.

## 2026-11-07 — ACH webhooks: re-fetch the transfer, apply only the steps we haven't

**Decision**
`ach_transfer.created` and `.updated` share one handler. `fetch` re-reads the transfer. `apply`
finds the payment by `(provider, provider_object_id)`, or else by the payment id in the transfer's
`idempotency_key` (`payment-<uuid>`, which Increase stores on the object). It then locks account →
payment, checks amount and currency, and asks `planPaymentActions` (domain) which steps are new,
given the status, whether `SUBMITTED_TO_NETWORK` is on the trace, and whether a `PAYMENT_RETURN`
exists. Steps apply in order in the event's transaction:
- accept a still-`PENDING` payment (including one the submitter gave up on);
- network submission (trace only);
- settlement → `COMPLETED` through `postLedgerEntry({ releaseHoldForTransactionId })`, so the trace
  reads ledger −$100 with available unchanged;
- return before settlement → `RETURNED`, hold released, nothing posted;
- return after settlement → a new `PAYMENT_RETURN` (`COMPLETED`, `provider_object_id` = transfer
  id, `related_transaction_id` = the payment, `ON CONFLICT DO NOTHING`) crediting the ledger, with
  the original left `COMPLETED`;
- `rejected` / `canceled` → `FAILED`, hold released.

A transfer without our key is `PaymentNotOursError` (permanent, like funding's "not ours"). A key
naming a missing payment retries. `provider_ref` is the transfer id, or the return's
`transaction_id` for return steps.

**Why**
Thin webhooks mean an event can't say which step happened. Diffing the cumulative object against
our own records under the account lock makes duplicates, older snapshots, created + updated racing
and the "webhook before the submitter stored the id" case converge on one effect per step.

**Alternatives**
Store a "last applied Increase status" column; map each event to one step.

**Tradeoff**
A settlement seen after we recorded a return-before-settlement is a no-op (net money is zero
either way). Sandbox webhooks aren't retried, so a missed one waits for the Events API backstop or
reconciliation (both out of scope here).

## 2026-11-07 — The recipient account number is stored for the outbox and shown as last four only

**Decision**
`payments.account_number` and `routing_number` are stored, because the submitter must send them.
Reads select `right(account_number, 4)` (`accountNumberLast4`), so the full number never leaves the
service layer except in the Increase request. Logs carry neither number, and the logger redacts `account_number`,
`accountNumber`, `routing_number` and `routingNumber` as a backstop. `ProviderTransfer` drops
Increase's echoed `account_number`.

**Why**
The outbox needs the full intent to retry. Masking in the query rather than the view means a new
read path can't leak it by accident.

**Alternatives**
Increase External Accounts (`external_account_id`) as a token, which is part of recipient
management and out of scope; application-level encryption with a KMS key.

**Tradeoff**
The number sits in plaintext in our database. In production it should be tokenized or encrypted,
and could be cleared once the transfer is accepted.

## 2026-11-07 — Our account links to its Increase account; simulations write nothing

**Decision**
`accounts.provider_id` is the Increase account that originates the account's ACH transfers.
`npm run increase:bootstrap` sets it from the sandbox account it creates, or from the already-linked
card's account. `POST /api/payments/:id/{submit,settle,return}` calls the Increase sandbox
simulation for the payment's transfer and returns 202. It changes nothing in our books: 404
another account's or a missing payment, 409 not yet submitted, 422 Increase refused the step, 502
timeout. State moves only through the webhook and the worker.

**Why**
Same reasoning as the card simulations: one path changes state, the one real ACH events take.
Per-account data, not an env var, because the link is per business account.

**Alternatives**
An `INCREASE_ACCOUNT_ID` env var; looking up the card's account on every submission.

**Tradeoff**
A database whose card was linked before this change needs `npm run increase:bootstrap` re-run once
(it only links the account).

## 2026-11-07 — Outcome counters: buffered per process, summed in a Postgres table

**Decision**
`countOutcome(name, labels)` adds to an in-process buffer. Every 5 s each process adds its buffer to
`metric_counters (name, labels jsonb, value)`, primary key `(name, labels)`, with one
`INSERT … ON CONFLICT DO UPDATE value = value + excluded.value`. The flush runs outside every
business transaction. Rows go in key order, so two processes flushing at once can't deadlock. A
failed flush logs, keeps the counts and tries again next time. Counts made inside the worker's
processing transaction (funding and card outcomes) are held in an `AsyncLocalStorage` scope and
kept only if that transaction commits, so a rolled-back and retried event isn't counted twice.
The buffer lives on `globalThis`, because Next gives route handlers and pages separate copies of
the module. State numbers (events by status, payment backlog) come from the tables at read time.
`GET /api/ops/metrics` returns JSON only.

**Why**
Web and worker are separate processes, and one endpoint has to show both. Postgres is already the
only infrastructure. Buffering keeps counter writes off the hot path: a counter write can never fail
or slow the work it counts, and it never contends on a hot row inside a money transaction. Counting
state from the tables can't drift.

**Alternatives**
In-process counters scraped per process (needs a Prometheus server and service discovery); a
counter row written inside each business transaction (serialises every transaction on one row and
fails the work when it fails); deriving every outcome from logs.

**Tradeoff**
Counters lag by up to 5 s, and a process that crashes loses its unflushed counts (at most 5 s
worth). Only the worker flushes once more on a clean stop (SIGTERM/SIGINT), after its loop. The web
process has no shutdown flush, so it can lose up to 5 s of counts on every deploy: Next drains
in-flight requests and exits itself, and a flush racing that exit never landed in testing.
`jsonb` labels mean a typo creates a new series; label values must come from fixed sets.
There is no Prometheus text format.
Counters are at-least-once per flush (a flush whose commit succeeds but whose answer is lost is
re-buffered and added again), so they are approximate: use them for rates and alerts, never for money.

## 2026-11-07 — Ops retry works only from FAILED

**Decision**
`POST /api/ops/events/:id/retry` locks the event row. If the event is `FAILED`, it sets `RETRY`
with `attempts = 0`, `claim_token + 1` and `next_attempt_at = now()`, and writes an `event.retry`
audit event in the same transaction. Any other status is 409 `event_not_retryable` and changes
nothing. That includes a second click and the loser of a concurrent retry, which waits on the lock
and then sees `RETRY`. `IGNORED` is not retryable. `last_error` is kept until the event is processed.

**Why**
`FAILED` is the only status that needs a person: retry budget spent, or a permanent error. An
`IGNORED` type is on the provider's ignore list, so a retry would just ignore it again. If we start
handling that type, that's a code change, and its events should be replayed deliberately, not one
click at a time. `RECEIVED`, `RETRY` and `PROCESSING` are already queued or being processed;
resetting their budget would only hide a loop.

**Alternatives**
Also allowing `IGNORED`; an idempotent 200 for a second retry (it would hide that someone else
already acted).

**Tradeoff**
To reprocess an ignored event after its type gains a handler, someone has to run a script.

## 2026-11-07 — Ops resolves a given-up payment: requeue, or confirm not sent after asking Increase

**Decision**
Two OPS-only actions, listed on `/ops/payments`, for a payment that is `PENDING` with
`submit_gave_up_at` set (anything else is 409 `payment_not_given_up` and changes nothing):
- `POST /api/ops/payments/:id/requeue` clears `submit_gave_up_at`, sets `submit_attempts = 0` and
  makes it due now, under account → payment locks, with a `payment.requeue` audit row. The submitter
  then resends with the same `payment-<id>` key.
- `POST /api/ops/payments/:id/confirm-not-sent` first asks Increase, with no transaction open and
  the adapter's 10 s timeout, for a transfer under our key (`GET /ach_transfers?idempotency_key=`).
  A transfer (or a stored `provider_object_id`) is 409 `transfer_exists`; no answer is 502
  `provider_unavailable`; neither changes anything. Otherwise one transaction locks account →
  payment, re-checks it is still given up **under the claim token seen before the call** (else 409
  `payment_changed`), runs `failPayment` (HOLD_RELEASED, then STATUS_CHANGED → FAILED) and writes a
  `payment.confirm_not_sent` audit row.

Confirm-not-sent is refused (409 `too_soon`, Increase not asked) until `submit_gave_up_at` is 5
minutes old (`CONFIRM_NOT_SENT_MIN_AGE_SECONDS`), so a create Increase is still processing or a
list that hasn't caught up can't read as "no transfer"; `/ops/payments` greys the button until then.
Both are counted as `ops_payment_actions_total{action,outcome}` and check Origin like login.
Requeue writes no trace row: it moves no money and no status.

**Why**
Requeue is always safe because Increase returns the first transfer for a repeated key, so it is
the default. Failing the payment releases money for spending, so it needs Increase's word that
nothing went out, and that word must still apply when we write. A requeue, a claim or a fresh give-up
in between bumps or clears what the transaction re-checks, so a stale "not found" can't fail a
payment that has since been sent.

**Alternatives**
Let Ops fail it without asking Increase; a status for "Ops confirmed"; a trace row for requeue.

**Tradeoff**
A submitter call that is still in flight long after its lease (more than ~2 min, against a 10 s
timeout) could create a transfer after Increase said none exists; its webhook would then be a
permanent `PaymentTransferMismatchError` for Ops on a FAILED payment. The given-up list reads
`status = 'PENDING' AND submit_gave_up_at IS NOT NULL` with no index of its own (like the backlog
count); a partial index is the follow-up if PENDING grows.

## 2026-11-07 — Ops event viewer: metadata only, keyset by received time

**Decision**
`GET /api/ops/events` and `/:id` never select `external_events.payload`; the API returns
`payload: "withheld"` and the page says so. The list shows provider, type, external id, status,
attempts, next attempt, the stored (sanitized) last error, delivery count, received and processed
times, and linked transaction ids (`external_events.transaction_id` plus the transactions of the
trace rows the event wrote). It is keyset-paginated on `(received_at, id)` with the same opaque
cursor as the transaction list. The detail adds deliveries (time, duplicate or not), the trace
steps the event wrote, the transactions touched and the Ops audit trail, all from one snapshot.
New indexes: `external_events (received_at, id)`, `(status, received_at, id)` and
`transaction_events (external_event_id)`.

**Why**
Payloads can hold personal data, and the worker never trusts them anyway (it re-fetches from the
provider). The status filter is the Ops path that matters (FAILED), so it gets its own index.

**Alternatives**
A redacted payload view (needs a per-provider allowlist of safe fields); OFFSET pagination.

**Tradeoff**
Filtering by provider or type alone walks the received-time index, which is fine at sandbox volume.
Add `(provider, event_type, received_at, id)` if that becomes a hot path. Ops has no transaction
page yet, so the transactions touched are listed by id, type, status and amount, without links.

## 2026-11-07 — Audit trail: one writer, inside the action's transaction

**Decision**
`recordAudit(tx, …)` (`services/audit.ts`) is the only writer of `audit_events`. It takes the
action's own transaction, so the audit row commits if and only if the action does. It records the
actor (user id, or SYSTEM), action, entity type and id, previous and new state, and the request's
correlation id (new `NOT NULL` column). State is typed as flat scalars, so a payload or a person's
details can't be passed in whole. Indexed by `(entity_type, entity_id, created_at)` and
`(created_at)`.

**Why**
An audit row written after commit can be lost, and one written before commit can describe
something that never happened. The correlation id joins the audit row to the request's log lines.

**Alternatives**
Writing audit rows asynchronously (the playbook rule for auxiliary work). An audit trail is part
of the action here, not auxiliary to it.

**Tradeoff**
A failing audit insert fails the Ops action. That's intended.
