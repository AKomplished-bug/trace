# Trace — work trial plan and write-up

## Problem
A business sees a balance and a list of rows. When the number looks wrong — a card hold that
settled lower, a webhook delivered twice, a payment returned days later, a provider report that
disagrees with ours — nobody can say *why*. Finance and Ops reconstruct the story by hand from
provider dashboards and logs.

## The slice we ship
One business, one USD account, one virtual card, outbound payments. Every money movement has a
**Money Trace** (timeline + ledger entries + balance impact + external references), a
deterministic **Replay**, and an **explained available balance**. Ops gets **reconciliation**
against provider records, an **investigation** page, and a read-only **event viewer**.

Core demo: fund $500 → authorize $80 (available $420) → settle $65 (available $435) → replay
→ provider reports $80 → mismatch detected → Ops investigates → resolved with an audit trail.

## Architecture
Modular monolith: Next.js (UI + REST API) and a Node worker, one Postgres that is also the job
queue. Details and invariants: `CLAUDE.md`.

## Data model (Postgres, amounts in integer cents)
| Table | Purpose / key constraints |
|---|---|
| `businesses`, `users` | demo tenant; users have role `OWNER` or `OPS` |
| `accounts` | one per business; `ledger_balance_cents` cache (= ledger sum) |
| `cards` | virtual card, `last4`, `provider_id`, status |
| `transactions` | business-level money movement: type, status, amount, provider ids (`UNIQUE(provider, provider_object_id, type)`), `related_transaction_id`, `idempotency_key` + `request_hash` (`UNIQUE(account_id, idempotency_key)`) |
| `holds` | card authorizations and pending payments; `ACTIVE / RELEASED / EXPIRED`; `UNIQUE(transaction_id)` |
| `payments` | outbound payment detail: recipient, provider id, status; idempotency via its transaction |
| `ledger_entries` | append-only; `UNIQUE(transaction_id, entry_type)` |
| `external_events` | raw provider events + processing state (also the queue): attempts, `claim_token`, lease; `UNIQUE(provider, external_event_id)` |
| `event_deliveries` | every delivery incl. duplicates |
| `transaction_events` | the trace: lifecycle steps ordered by `seq` (per transaction) and `account_seq` (per account), ledger/available balance after each, `provider_ref` |
| `audit_events` | who did what, previous/new state |
| `reconciliation_runs`, `reconciliation_records` | internal vs external comparison results |
| `investigations`, `investigation_notes` | Ops cases and notes |

## API (REST, `/api`)
`POST /auth/login` · `GET /account` · `GET /account/balance` (with explanation) ·
`GET /transactions` · `GET /transactions/:id` · `GET /transactions/:id/timeline` ·
`GET /transactions/:id/replay` · `POST /funding` · `POST /cards/:id/authorize` (simulator) ·
`POST /cards/:id/settle` (simulator) · `POST /payments` · `GET /payments/:id` ·
`POST /webhooks/:provider` · `GET /ops/reconciliation` · `POST /ops/reconciliation/run` ·
`GET /ops/reconciliation/:id` · `POST /ops/reconciliation/:id/retry` ·
`GET|POST /ops/investigations` · `GET /ops/events` · `POST /ops/events/:id/retry` ·
`GET /ops/metrics`

## UI
Owner: dashboard (available / ledger / pending, recent activity), activity, **transaction
detail (hero: trace, replay, graph)**, card, payments, balance explanation.
Ops: dashboard counts, reconciliation queue, investigation page, event viewer.

## Out of scope (and why)
Real money/banking, physical cards, KYC/AML, multi-currency, payroll/accounting, complex
permissions, microservices, Redis/Kafka — none of it changes whether the money story is correct,
and each would cost hours we need for depth.

## Timeline (48h)
| Hours | Deliverable |
|---|---|
| 0–3 | Scaffold, schema, migrations, ledger + balance domain with invariant tests |
| 3–8 | Stripe funding end to end, card simulator auth → settle, dashboard + basic trace; **deployed** |
| 8–16 | Duplicates/out-of-order/retries hardened, reversal, outbound payments (second provider) |
| 16–26 | Replay, balance explanation, money graph, transaction detail polish |
| 26–36 | Reconciliation, investigations, event viewer, audit trail, metrics |
| 36–44 | Concurrency/load checks, edge-case tests (spec §28), UI polish, write-up |
| 44–48 | Buffer |

## Open questions
- Deployment target (Corgi-provided AWS vs our choice) — needed by hour 6 for Stripe webhooks.
- Second provider: Increase chosen (see `DECISIONS.md`).

## What we'd do next
_Filled in at the end._ Already known:
- Payment outbox columns (submission state, attempts, provider idempotency key) arrive with
  outbound payments; the `holds(expires_at)` index for active holds arrives with hold expiry.
