# Trace — engineering guide

Trace is a business banking sandbox built like an observable financial system: every dollar
has a traceable, replayable story. Product spec: `docs/product-spec.md`. Plan and write-up:
`TRIAL.md`. Decisions: `DECISIONS.md`. This file is the architecture contract; read it before
changing anything.

## Architecture — modular monolith, two processes, one Postgres

```text
Stripe / second provider / card simulator
        │ webhook: verify signature → INSERT raw event → 200   (no business logic here)
        ▼
external_events   UNIQUE(provider, external_event_id)   ← also the work queue
        │ worker claims due rows: FOR UPDATE SKIP LOCKED
        ▼
one DB transaction per event:
  lock account row → conditional state transition → holds / ledger entries
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
    stripe/  <second-provider>/  card-simulator/
  services/        application layer: orchestrates domain + db inside one transaction
  worker/          job loop and handlers
  app/             Next.js pages and api route handlers (thin: validate → service → respond)
  lib/             logger, config, ids, money formatting
```

Dependency direction: `app`, `worker` → `services` → `domain`, `db`, `integrations`.
`domain` imports nothing from the others. Provider types never cross into `domain`.

## Money rules (tested invariants — never break them)

1. Amounts are **integer cents** (`bigint` in Postgres, `number` in TS within safe range). USD
   only. Never floats. Store UTC, render local.
2. **The ledger is append-only.** No UPDATE or DELETE on `ledger_entries`, ever. Corrections
   are new `ADJUSTMENT` entries. Sign convention: credit = positive, debit = negative.
3. `accounts.ledger_balance_cents` is a cache, written in the same DB transaction as the ledger
   entries, and must always equal `SUM(ledger_entries.amount_cents)` for the account.
4. **Available = ledger balance − SUM(active holds).** Holds cover card authorizations and
   pending outbound payments. Nothing else reduces available balance.
5. Authorization creates a hold and **no ledger entry**. Settlement posts the ledger debit and
   releases the hold in the same transaction.
6. Reversal/return is a **new transaction** linked by `related_transaction_id`; the original is
   never modified beyond its status.
7. Processing the same external event twice yields the same state as processing it once.
8. Every state transition is conditional on the current state
   (`UPDATE … WHERE id = $1 AND status = $2`); zero rows updated = illegal/duplicate transition,
   handled explicitly.
9. Every financial change writes a `transaction_events` row (the trace) in the same transaction.
   Timeline, replay and the money graph read only from it.

## Idempotency (three layers)

- **External events:** `UNIQUE(provider, external_event_id)`; every delivery, including
  duplicates, is recorded in `event_deliveries` so Ops sees "received twice, no effect".
- **Commands:** `POST /payments`, `POST /funding` require `Idempotency-Key`; stored with a
  unique constraint on the row it creates. Same key + same body → same response; same key +
  different body → 409.
- **Ledger:** `UNIQUE(transaction_id, entry_type)` on `ledger_entries` so one transaction can't
  post the same effect twice.

## Event processing

- Webhook handlers: verify signature, insert raw event `ON CONFLICT DO NOTHING`, record the
  delivery, return 200. No other work.
- Worker claims `WHERE status IN ('RECEIVED','RETRY') AND next_attempt_at <= now()` with
  `FOR UPDATE SKIP LOCKED`, processes inside one transaction, then marks PROCESSED.
- **No network call inside a DB transaction or while holding a row lock.** Outbound provider
  calls happen in the worker, after commit, using a persisted intent (outbox) and the same
  idempotency key on retries.
- Failures: `attempts++`, exponential backoff, terminal `FAILED` after N attempts with the error
  and likely cause stored. Ops can retry; retries are safe because of the rules above.
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
  `SECOND_PROVIDER_API_KEY`, `SECOND_PROVIDER_WEBHOOK_SECRET`, `SESSION_SECRET`). Validated
  at startup with zod; fail fast with a message naming the missing variable. Never in client code.

## API conventions

- REST under `/api`. Validate every input with zod at the route; errors as
  `{ error: { code, message } }`. Never return stack traces or internal errors.
- Demo auth: signed session cookie; roles `OWNER` (scoped to one business) and `OPS`.
  `/api/ops/**` requires `OPS`.

## Observability

- `pino` structured JSON logs. Every request/job carries `correlation_id`; log `event_id`,
  `transaction_id`, `account_id` on every external call and state change.
- Never log secrets, headers, raw card data or personal data.
- Counter per outcome for each workflow step (`events_processed_total{type,outcome}`,
  `reconciliation_results_total{status}` …), exposed at `/api/ops/metrics`.

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

Filled in by the scaffold PR (dev, worker, db up/migrate/seed, typecheck, lint, test, build).
