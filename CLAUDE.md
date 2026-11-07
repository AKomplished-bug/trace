# Trace — engineering guide

Trace is a business banking sandbox built like an observable financial system: every dollar
has a traceable, replayable story. Product spec: `docs/product-spec.md`. Plan and write-up:
`TRIAL.md`. Decisions: `DECISIONS.md`. This file is the architecture contract; read it before
changing anything.

## Architecture — modular monolith, two processes, one Postgres

```text
Stripe (funding) / Increase (cards, ACH)
        │ webhook: verify signature → INSERT raw event → 200   (no business logic here)
        ▼
external_events   UNIQUE(provider, external_event_id)   ← also the work queue
        │ worker claims one due row: FOR UPDATE SKIP LOCKED, lease + claim_token
        ▼
handler.fetch: provider reads, outside any transaction, with a timeout
        ▼
one DB transaction per event (handler.apply):
  lock event row → lock account row → conditional state transition → holds / ledger entries
  → transaction_events (trace) → cached ledger balance → mark event PROCESSED
        ▼
reconciliation job: pulls provider records via API, compares with ours
```

- **web** — Next.js (App Router). UI pages and the REST API (`src/app/api/**` route handlers).
- **worker** — `src/worker/index.ts`, a long-lived Node process: event processor, outbound
  payment submitter, hold expiry, reconciliation. Several instances must be safe at once.
- **Postgres** — the only infrastructure. It is the source of truth and the queue. No Redis.

## Layout

```text
src/
  domain/          pure TypeScript: rules, state machines, balance math, replay. No I/O,
                   no framework, no provider imports. Most tests live here.
    ledger/ cards/ payments/ funding/ reconciliation/ replay/
  db/              schema, migrations, queries, transaction helper
  integrations/    one folder per provider; adapters map provider payloads → internal events
    stripe/  increase/
  services/        application layer: orchestrates domain + db inside one transaction
  worker/          job loop and handlers
  app/             Next.js pages and api route handlers (thin: validate → service → respond)
  lib/             logger, config, ids, money formatting, safe error messages
```

Dependency direction: `app`, `worker` → `services` → `domain`, `db`, `integrations`.
`domain` imports nothing from the others. Provider types never cross into `domain`.

## Money rules (tested invariants — never break them)

1. Amounts are **integer cents** (`bigint` in Postgres, `number` in TS within safe range). USD
   only. Never floats. Store UTC, render local.
2. **The ledger is append-only.** No UPDATE or DELETE on `ledger_entries`, ever. Corrections
   are new `ADJUSTMENT` transactions. Sign convention: credit = positive, debit = negative.
   Each transaction type posts exactly one entry type (`ENTRY_TYPE_FOR_TRANSACTION` in
   `domain/ledger`), so a transaction has at most one ledger entry.
3. `accounts.ledger_balance_cents` is a cache, written in the same DB transaction as the ledger
   entries, and must always equal `SUM(ledger_entries.amount_cents)` for the account.
4. **Available = ledger balance − SUM(active holds).** Holds cover card authorizations and
   pending outbound payments. Nothing else reduces available balance.
5. Authorization creates a hold and **no ledger entry**. Settlement posts the ledger debit and
   releases the hold in the same transaction — `postLedgerEntry({ releaseHoldForTransactionId })`
   makes every state change first (entry, cached balance, hold status), then writes
   LEDGER_POSTED and HOLD_RELEASED, both with the final balances. The trace never shows an
   available balance that wasn't true outside the transaction. A settlement whose hold already
   EXPIRED or was RELEASED (late capture) still posts; `SETTLED_AFTER_HOLD_CLOSED` records it.
6. Reversal/return is a **new transaction** linked by `related_transaction_id`; the original is
   never modified beyond its status.
7. Processing the same external event twice yields the same state as processing it once.
8. Every state transition is conditional on the current state
   (`UPDATE … WHERE id = $1 AND status = $2`); zero rows updated = illegal/duplicate transition,
   handled explicitly.
9. Every financial change writes a `transaction_events` row (the trace) in the same transaction,
   through `appendTraceEvent` only (it assigns `seq` per transaction and `account_seq` per
   account under the account lock). Timeline, replay and the money graph read only from it and
   order by `account_seq` / `seq`, never by `occurred_at`.
10. **Trace order within one DB transaction:** apply an effect, then write its row, before the
    next effect; effect rows (`HOLD_CREATED`, `LEDGER_POSTED`, `HOLD_RELEASED`, `HOLD_EXPIRED`) come
    before no-effect rows (`STATUS_CHANGED`, `HOLD_EXCEEDS_AVAILABLE`,
    `SETTLED_AFTER_HOLD_CLOSED`). `appendTraceEvent` records the live balances at the moment it
    runs, and replay checks every row as "balances before + this row's own effect = recorded
    after", so a row written before its effect, or after another effect, fails replay. The one
    sanctioned exception is settlement, which goes **only** through
    `postLedgerEntry({ releaseHoldForTransactionId })`: it applies the debit and the hold release,
    then writes LEDGER_POSTED and HOLD_RELEASED back to back with the same final balances, and
    replay recognises exactly that pair. Never release a settled hold and post its debit any other
    way in one transaction.

## Locks

- Order, always: **event row → account row → transaction / hold / payment rows.** Taking them
  in one order is what rules out deadlocks between the worker and API commands.
- The account row is the serialization point for its money: every writer of ledger entries,
  holds or trace rows takes `SELECT … FOR NO KEY UPDATE` on it first (`lockAccount`). NO KEY
  so inserts that reference the account aren't blocked by FK checks.
- No lock is held across a network call (see Event processing).

## Provider ids

`transactions.provider_object_id` names the provider object the transaction tracks, unique per
`(provider, provider_object_id, type)`:

| Transaction type | `provider` | `provider_object_id` |
|---|---|---|
| `FUNDING` | `stripe` | PaymentIntent id |
| `CARD_PURCHASE` | `increase` | `card_payment` id |
| `CARD_REVERSAL` | `increase` | `card_refund` element id (one transaction per refund, so partial refunds stack); `related_transaction_id` → the purchase when the refund is on the purchase's `card_payment`, else null (Increase may put a refund on its own `card_payment` with no link) |
| `OUTBOUND_PAYMENT`, `PAYMENT_RETURN` | `increase` | `ach_transfer` id (the return is the same transfer with the other type; `related_transaction_id` → the payment). Steps' `provider_ref`: the transfer id, or the return's `transaction_id` for return steps |

The element behind each lifecycle step (settlement, reversal, return id) goes in
`transaction_events.provider_ref`, which reconciliation matches on. For card payments it is also
how the worker knows which elements it already applied. A `card_reversal` element (voiding an
authorization) moves no money, so it is a step on the purchase's trace, not a transaction.

## Idempotency (three layers)

- **External events:** `UNIQUE(provider, external_event_id)`; every delivery, including
  duplicates, is recorded in `event_deliveries` so Ops sees "received twice, no effect".
- **Commands:** `POST /payments`, `POST /funding` require `Idempotency-Key`; stored only on
  `transactions` as `UNIQUE(account_id, idempotency_key)` with a `request_hash` of the body
  (payments link to their transaction). Same key + same body → same response; same key +
  different body → 409.
- **Ledger:** `UNIQUE(transaction_id, entry_type)` on `ledger_entries` so one transaction can't
  post the same effect twice. The same effect with a different amount is a `LedgerConflictError`,
  never a silent no-op.

## Event processing

- Webhook handlers: verify signature, insert raw event `ON CONFLICT DO NOTHING`, record the
  delivery, return 200. No other work.
- Worker claims **one event per pass**: `WHERE status IN ('RECEIVED','RETRY') AND
  next_attempt_at <= now()` (or `PROCESSING` with an expired lease) with `FOR UPDATE SKIP
  LOCKED`, setting `PROCESSING`, `attempts + 1`, `claim_token + 1` and a lease. `attempts` is
  the retry budget; `claim_token` is the fencing token — every later update is conditional on
  it, so a worker whose lease expired can't apply effects.
- Handlers have two phases: `fetch` (optional provider reads; after the claim commits, no
  transaction open, 10 s timeout) and `apply` (effects, in the transaction that locks the event
  row and marks it PROCESSED). `apply` must treat `fetched` as possibly stale: lock the account,
  re-read the entity, and transition only from the expected status.
- `apply` never catches a service error and carries on: a JS throw after DB writes doesn't abort
  the transaction by itself, so swallowing it would commit half an effect. Let it propagate; the
  worker rolls the transaction back and retries.
- Event types with no handler are retried and end `FAILED` (they surface to Ops). Only types in
  the provider's explicit ignore list become `IGNORED`.
- **No network call inside a DB transaction or while holding a row lock.** Outbound provider
  calls happen in the worker, after commit, using a persisted intent (outbox) and the same
  idempotency key on retries. Outbound payments: a `PENDING` `payments` row is the intent; the
  submitter claims it like an event (`submit_attempts`, `submit_claim_token`, lease in
  `next_submit_at`) and calls Increase with `Idempotency-Key: payment-<payment id>`. When the
  outcome is unknown (budget spent, reused key) it gives up: still `PENDING` with its hold and
  `submit_gave_up_at` set. Ops then requeues it (`POST /api/ops/payments/:id/requeue`: fresh
  budget, same key) or confirms it not sent (`…/confirm-not-sent`: only 5 min after the give-up
  and after Increase, asked outside any transaction, has no transfer under our key; then `failPayment` under the claim
  token seen before the call). Both are audited and conditional on the given-up state.
- Failures: exponential backoff (5 s doubling, capped at 15 min), terminal `FAILED` after 10
  attempts with a sanitized error stored (error class + our message; database errors as
  SQLSTATE and constraint name, never `detail` or values). Ops retry
  (`POST /api/ops/events/:id/retry`) works only from `FAILED`: under the event row lock it sets
  `RETRY`, resets `attempts`, bumps `claim_token`, makes it due now and writes an audit event, all
  in one transaction; a second or concurrent retry is a 409. Retries are safe because of the rules
  above.
- Out-of-order (e.g. settlement before authorization): retry with backoff; if it never
  resolves, it surfaces as an Ops exception — never silently dropped.

## Reconciliation

Compares our transactions with records **fetched from the provider API** (not our webhook
copies). Statuses: `MATCHED, AMOUNT_MISMATCH, STATUS_MISMATCH, MISSING_INTERNAL,
MISSING_EXTERNAL, DUPLICATE, PENDING_EXTERNAL`. A grace window separates "not arrived yet"
(PENDING_EXTERNAL) from "missing". Ops resolution never edits history: it writes a note, an
audit event, and optionally an `ADJUSTMENT` ledger entry.

## External calls

- Every provider call goes through its adapter, has a timeout (default 10 s), logs the provider
  request id with our entity ids, and handles failure where it happens.
- Secrets only from env (`DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `INCREASE_API_KEY`, `INCREASE_WEBHOOK_SECRET`, `SESSION_SECRET`). Validated
  at startup with zod; fail fast with a message naming the missing variable. Never in client code.

## API conventions

- REST under `/api`. Validate every input with zod at the route; errors as
  `{ error: { code, message } }`. Never return stack traces or internal errors.
- Demo auth: signed session cookie; roles `OWNER` (scoped to one business) and `OPS`.
  `/api/ops/**` requires `OPS`. Auth and Ops POSTs also refuse a cross-origin `Origin` with 403
  (`checkSameOrigin` in `app/api/handler.ts`; in Ops handlers right after `requireOps`).
- `external_events.payload` is never selected, returned or rendered (it can hold personal data);
  the Ops event viewer shows "payload withheld".
- Ops actions write `audit_events` only through `recordAudit` (`services/audit.ts`), inside the
  action's own transaction, with the request's `correlationId` (from `withRequestLog`). Previous
  and new state are flat scalars (ids, statuses, counts), never payloads.

## Observability

- `pino` structured JSON logs. Every request/job carries `correlation_id`; log `event_id`,
  `transaction_id`, `account_id` on every external call and state change.
- Never log secrets, headers, raw card data or personal data.
- Counter per outcome for each workflow step, through `countOutcome(name, labels)`
  (`services/metrics.ts`) only. It buffers in process (no I/O, never throws); each process
  (`apiDeps()` in web, the worker loop) flushes every 5 s to `metric_counters` with
  `INSERT … ON CONFLICT DO UPDATE value = value + n`, outside business transactions, and keeps the
  counts on a failed flush. Only the worker flushes on shutdown; the web process can lose up to
  5 s of counts (Next drains requests itself). Counts made inside the worker's processing transaction are kept only
  if it commits (`countAfterCommit`). Label values come from fixed sets, never ids or raw input.
  Wired: `events_processed_total{provider,type,outcome}`, `webhooks_received_total{provider,outcome}`,
  `funding_requests_total{outcome}`, `funding_outcomes_total{outcome}`,
  `card_steps_total{kind,outcome}`, `payment_steps_total{kind,outcome}`, `payment_submissions_total{outcome}`,
  `ops_event_retries_total{outcome}`, `ops_payment_actions_total{action,outcome}`,
  `replay_mismatch_total{scope}`.
- State is counted from the tables, not counters: events by status and the payment backlog
  (`given_up_payments` …). `GET /api/ops/metrics` (OPS, JSON) returns both; `/ops` shows them.

## Testing

- Financial correctness first. Domain unit tests (Vitest) for balance math, holds, settlement,
  reversal, payment transitions, replay, reconciliation classification.
- Integration tests against real Postgres (docker compose): webhook → worker → ledger,
  duplicate delivery, two workers racing on the same events, idempotent commands.
- Invariant check after every integration test: cached balance == ledger sum; replayed state
  == stored state.
- Provider adapters are tested against recorded fixture payloads; tests never call real
  providers.

## Working rules

- Smallest change that does the job; one concern per branch. Match surrounding code.
- Migrations are forward-only and backward compatible with the running code.
- Every new query path on a growing table gets an index.
- Branch per change from fresh `origin/main`; PRs are reviewed before merge. Commit as
  `athulkrishna8781@gmail.com`, single-line imperative messages, stage by path.
- Record every non-obvious decision in `DECISIONS.md` (spec format) in the same PR.

## Commands

```sh
npm ci && cp .env.example .env   # first time
npm run db:up        # Postgres 16 in docker on localhost:5433 (databases trace, trace_test)
npm run db:migrate   # apply src/db/migrations to DATABASE_URL
npm run db:seed      # idempotent demo data (Acme Inc., owner + ops users, $0 account, card)
npm run db:seed:demo # optional, dev only: base seed + the $500 → $80 auth → $65 settle story
npm run db:generate  # write a new SQL migration from src/db/schema.ts (review and commit it)
npm run dev          # Next.js web + API
npm run worker       # event worker (src/worker/index.ts)
npm run increase:bootstrap  # once: link the seeded card to a funded Increase sandbox card
npm run typecheck
npm run lint
npm test             # Vitest: unit + integration against DATABASE_URL_TEST (needs db:up)
npm run build
```
