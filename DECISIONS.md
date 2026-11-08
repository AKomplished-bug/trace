# Decisions

The decisions that shaped Trace, as the system stands now. Each links to its full entry in
[docs/decision-log-full.md](docs/decision-log-full.md), the working log written as the work
progressed (context, alternatives, trade-offs). Where a log entry was later superseded, the table
below says so.

## Key decisions

### Architecture

#### 1. Modular monolith: two processes, one Postgres

- **Decision:** One TypeScript codebase run as two processes (Next.js web/API, a long-lived worker) on one Postgres.
- **Why:** The hard problems are correctness and explainability, not scale. The domain is shared by API, worker and tests; webhook ingestion stays fast and processing retries on its own.
- **Trade-off:** API and UI scale together. Rejected: a separate API service, microservices.
- **Where:** `src/worker/index.ts`, `src/domain/` · [full entry](docs/decision-log-full.md#2026-11-07--modular-monolith-nextjs--one-node-worker--postgres)

#### 2. Postgres is the queue

- **Decision:** `external_events` is the work queue. Storing the raw event is the enqueue; workers claim rows with `FOR UPDATE SKIP LOCKED`.
- **Why:** No window where an event is stored but not queued, or queued but not stored. Retry state and errors are queryable by Ops.
- **Trade-off:** Lower throughput ceiling than a dedicated queue, far above what this needs. Rejected: Redis/BullMQ, SQS.
- **Where:** `src/worker/events.ts` · [full entry](docs/decision-log-full.md#2026-11-07--postgres-is-the-queue-no-redis)

#### 3. Workers claim with a lease and a fencing token

- **Decision:** A pass claims one row, bumping `attempts` (retry budget) and `claim_token` (fence), with a 120 s lease. Provider reads run after the claim commits; effects apply in a transaction that checks the token. Backoff 5 s doubling, capped at 15 min; `FAILED` after 10 attempts. Payments, reconciliation runs and the poll cursor use the same pattern.
- **Why:** A dead worker can't strand work, a worker whose lease lapsed can't apply effects, and no lock is held across a network call. A poison event can't burn the budget of others.
- **Trade-off:** Work from a dead worker waits out the lease. Rejected: holding the row lock through processing (invisible to Ops, and a lock across the provider call).
- **Where:** `src/worker/events.ts`, `src/worker/payment-submitter.ts` · [full entry](docs/decision-log-full.md#2026-11-07--worker-claims-events-with-a-lease)

### Money correctness

#### 4. Signed append-only ledger with holds

- **Decision:** One signed entry per transaction in an append-only `ledger_entries` (integer cents). Card authorizations and pending payments are holds, not entries. `Available = Ledger balance − Pending card holds − Pending payments`, with the formula in the domain and rendered by the UI.
- **Why:** Matches how cards work (authorization ≠ settlement): the $80 → $65 case is one transaction that posts −$65 and releases the $80 hold. Corrections are new `ADJUSTMENT` transactions.
- **Trade-off:** No double-entry contra accounts, so provider-side clearing isn't modelled. Available can go negative after an approved authorization.
- **Where:** `src/domain/ledger/balance.ts`, `src/services/ledger.ts` · [ledger](docs/decision-log-full.md#2026-11-07--single-entry-signed-ledger-with-holds), [formula](docs/decision-log-full.md#2026-11-07--available-balance-the-exact-formula)

#### 5. Three-layer idempotency, enforced by constraints

- **Decision:** `UNIQUE(provider, external_event_id)` for events; `Idempotency-Key` with a `request_hash` on `transactions` (`UNIQUE(account_id, idempotency_key)`, different body → 409); `UNIQUE(transaction_id, entry_type)` on ledger entries.
- **Why:** Each layer catches a different failure: provider retries, client retries, our own worker re-running a half-processed event. Constraints, not check-then-insert, so races are harmless.
- **Trade-off:** A little more schema. Rejected: application checks, distributed locks.
- **Where:** `src/db/schema.ts` · [full entry](docs/decision-log-full.md#2026-11-07--three-layer-idempotency)

#### 6. Replay checks the trace, and the trace has a write order

- **Decision:** Replay is a pure fold over `transaction_events` in `account_seq` order, checking each row as "balances before + this row's effect = recorded after". Within one DB transaction, effect rows are written before no-effect rows; settlement writes `LEDGER_POSTED` then `HOLD_RELEASED` only through `postLedgerEntry`.
- **Why:** "Replayed equals stored" becomes visible per transaction and an invariant after every integration test, and a buggy writer shows at the exact step.
- **Trade-off:** Settlement pairing is a heuristic (adjacent rows with equal balances), and the account replay reads the whole trace per `/balance` view.
- **Where:** `src/domain/replay/replay.ts` · [full entry](docs/decision-log-full.md#2026-11-07--replay-folds-the-recorded-trace-and-checks-every-step-against-it)

### Provider integration

#### 7. Act on the re-fetched provider object, not the webhook body

- **Decision:** Handlers re-fetch the PaymentIntent, card payment or ACH transfer and apply only the elements or steps not yet on our trace, under the account lock. A Stripe amount or currency that differs from ours fails to Ops instead of posting.
- **Why:** Increase webhooks are thin, and a stale, replayed or forged payload can't move money. Diffing by element id makes duplicates, older snapshots and racing created/updated events converge on one effect.
- **Trade-off:** One provider read per event. A step we can't place (settlement with no authorization) retries and ends `FAILED`.
- **Where:** `src/worker/stripe.ts`, `src/worker/increase.ts` · [funding](docs/decision-log-full.md#2026-11-07--funding-outcomes-trust-the-fetched-paymentintent-a-mismatch-goes-to-ops), [cards](docs/decision-log-full.md#2026-11-07--card-events-re-fetch-the-card-payment-and-apply-only-its-new-elements), [ACH](docs/decision-log-full.md#2026-11-07--ach-webhooks-re-fetch-the-transfer-apply-only-the-steps-we-havent)

#### 8. Increase events come from polling the Events API

- **Decision:** A worker loop reads `GET /events` every 5 s into the same `ingestEvent` path a webhook uses (`source = 'poll'`). The cursor is a leased row, re-read with a 60 s overlap.
- **Why:** The anonymous sandbox can't register webhook subscriptions, and sandbox webhooks aren't retried, so without polling no card or ACH step reaches the ledger. A listed event is the same object as a webhook body, so dedup and handlers are shared.
- **Trade-off:** Up to ~5 s more latency. An event that becomes visible more than 60 s late is missed (reconciliation is the backstop).
- **Where:** `src/services/increase-events-poller.ts` · [poller](docs/decision-log-full.md#2026-11-07--increase-events-are-also-polled-into-the-webhooks-ingestion-path), [cursor](docs/decision-log-full.md#2026-11-07--the-poll-cursor-is-its-own-leased-row-re-read-with-a-60-s-overlap)

#### 9. Events about objects that aren't ours are IGNORED

- **Decision:** A verified event about a card, account or PaymentIntent we don't own throws `NotOursEventError`; the worker marks it `IGNORED` with "not ours: …" and counts `outcome="not_ours"`.
- **Why:** The poller reads the whole sandbox group, so foreign events arrive routinely. Retrying can't make them ours, and `FAILED` would bury real exceptions in noise.
- **Trade-off:** A card payment that arrives before its card is linked is ignored, not retried; the bootstrap links the card before it can be used. Rejected: filtering in the poller (it would have to re-fetch every object).
- **Where:** `src/worker/events.ts` · [full entry](docs/decision-log-full.md#2026-11-07--verified-events-about-objects-that-arent-ours-are-ignored-not-retried-or-failed)

### Failure handling and operations

#### 10. Payment outbox; an unknown outcome stays PENDING with its hold

- **Decision:** `POST /api/payments` only writes the payment, its hold and trace under the account lock. The worker submits with `Idempotency-Key: payment-<id>`. A 4xx on the first attempt fails it and releases the hold; any unknown outcome (timeouts until the budget is spent, a later 4xx, a reused key) gives up with the payment still `PENDING` and its hold kept. Ops can requeue, or confirm not sent only after asking Increase.
- **Why:** After a timeout the transfer may exist. Releasing the hold could let the owner spend money that already left. Only a first-attempt refusal is proof nothing was created.
- **Trade-off:** A given-up payment reserves its funds until an event arrives or Ops acts. Rejected: `FAILED` on exhaustion (a late event had nowhere to go), releasing the hold on exhaustion.
- **Where:** `src/worker/payment-submitter.ts`, `src/services/ops-payments.ts` · [outbox](docs/decision-log-full.md#2026-11-07--outbound-payments-go-through-an-outbox-on-payments-sent-by-the-worker), [failures](docs/decision-log-full.md#2026-11-07--submission-failures-a-first-attempt-refusal-releases-the-hold-unknown-gives-up-pending), [Ops actions](docs/decision-log-full.md#2026-11-07--ops-resolves-a-given-up-payment-requeue-or-confirm-not-sent-after-asking-increase)

### Reconciliation

#### 11. Reconcile against the provider API; adjust at most once

- **Decision:** Runs compare our transactions with records listed from the provider API (not our webhook copies), with a 1 h grace window for "not arrived yet". Resolving an investigation runs in one transaction under its row lock and may post one `ADJUSTMENT`, only on an `AMOUNT_MISMATCH` and only for the amount that brings the posted net to the provider's.
- **Why:** Webhook copies can't show what we missed. Recomputing the amount under the account lock stops a second case or a double submit from adjusting twice; history is never edited.
- **Trade-off:** Runs are on request only. A note-only resolution comes back on the next run because the sides still disagree.
- **Where:** `src/domain/reconciliation/index.ts`, `src/services/reconciliation.ts`, `src/services/investigations.ts` · [classification](docs/decision-log-full.md#2026-11-07--classification-pairing-grace-window-and-what-counts-as-our-amount), [resolution](docs/decision-log-full.md#2026-11-07--resolving-an-investigation-one-transaction-an-adjustment-at-most-once)

### Security and auth

#### 12. Per-user scrypt passwords and a Postgres login throttle

- **Decision:** Email and password per user, hashed with Node scrypt (N=2^15, r=8, p=3, parameters stored with the hash), one 401 for every failure. Attempts are counted before the password check, under row locks on HMAC'd email and IP keys (10 per email, 50 per IP in 15 min); if counting fails, login fails closed.
- **Why:** The deployed app first let anyone pick a user, including Ops. Counting under the lock is what makes the throttle race-safe across web instances that share only Postgres.
- **Trade-off:** We own password storage; no self-service reset. Anyone can lock an email for 15 min. Rejected: a shared access code, Cognito, check-then-record.
- **Where:** `src/lib/password.ts`, `src/services/login-throttle.ts` · [passwords](docs/decision-log-full.md#2026-11-07--per-user-passwords-not-a-shared-access-code-or-cognito), [throttle](docs/decision-log-full.md#2026-11-07--login-throttle-in-postgres-counted-before-the-password-is-checked)

### Deployment

#### 13. ECS Fargate + RDS behind CloudFront, in Sydney only

- **Decision:** One image on ECS Fargate as `trace-web` and `trace-worker`, RDS Postgres 16, CloudFront for HTTPS in front of an HTTP-only ALB that forwards only requests carrying our origin secret. Everything in ap-southeast-2.
- **Why:** The worker is long-lived, which rules out serverless hosts. The account's SCP allows only ap-southeast-2 and denies App Runner; there is no domain, so CloudFront's certificate gives HTTPS.
- **Trade-off:** UK reviewers pay ~270 ms per round trip; `Server-Timing` and the Ops latency table show the app's share. No backups on the free plan, no HA, CLI scripts that don't fix drift.
- **Where:** `infra/aws/` · [AWS](docs/decision-log-full.md#2026-11-07--deployed-on-aws-ecs-fargate--rds-not-render-or-vercel), [region](docs/decision-log-full.md#2026-11-07--one-region-ap-southeast-2-public-subnets-no-nat-gateway), [latency](docs/decision-log-full.md#2026-11-07--sydney-only-so-uk-reviewers-pay-270-ms-per-round-trip)

### UI

#### 14. Owner forms share the API's schema and keep the Idempotency-Key per body

- **Decision:** The payment form validates with the API's zod schema. The key is reused while the body is unchanged and replaced when it changes; an unknown outcome reads "We couldn't confirm this went through. Check Activity before trying again." Amounts are signed only once posted.
- **Why:** The form can't drift from the API, and resubmitting after a lost response replays instead of paying twice. An unsigned, struck-through amount for an expired authorization doesn't claim money moved.
- **Trade-off:** The client bundle carries the validation rules (already public). Rejected: a separate client schema.
- **Where:** `src/app/_lib/money-forms.ts`, `src/app/_lib/idempotency.ts` · [full entry](docs/decision-log-full.md#2026-11-07--the-owner-forms-validate-with-the-apis-own-schema)

## Other decisions

| Decision | Reason | Entry |
|---|---|---|
| Stripe test mode PaymentIntents for funding | Simplest real money-in sandbox; listable for reconciliation | [full](docs/decision-log-full.md#2026-11-07--stripe-test-mode-for-funding) |
| Increase sandbox for cards and ACH | Self-serve, a simulation for every step we need, idempotency keys. *The planned test-only fault injector was not built.* | [full](docs/decision-log-full.md#2026-11-07--increase-sandbox-for-card-lifecycle-and-outbound-payments) |
| Enums for statuses; sign only on ledger entries | Illegal values unrepresentable; one place says which way money moved. *Trace kinds have since grown from five to eight.* | [full](docs/decision-log-full.md#2026-11-07--schema-conventions) |
| Late settlement posts even if the hold closed | The provider moved the money; `SETTLED_AFTER_HOLD_CLOSED` makes it visible | [full](docs/decision-log-full.md#2026-11-07--late-settlement-posts-even-if-the-hold-already-closed) |
| Funding calls Stripe in the request, after commit; a failed call stays `PENDING` | The owner gets the PaymentIntent id; only Stripe's webhook decides the outcome. A known exception to the outbox rule | [call](docs/decision-log-full.md#2026-11-07--funding-calls-stripe-from-the-api-request-after-commit), [failure](docs/decision-log-full.md#2026-11-07--a-failed-stripe-call-leaves-funding-pending-not-failed) |
| Funding webhooks match by PaymentIntent id, then `metadata.transaction_id` | A lost Stripe response can't leave a charge uncredited. *Superseded in part: no metadata is now IGNORED (not ours), not FAILED.* | [full](docs/decision-log-full.md#2026-11-07--funding-webhooks-find-their-transaction-by-paymentintent-id-then-by-metadata) |
| HMAC-signed session cookie, 12 h, Origin check on auth POSTs | No session table; API auth needs no DB read. *Superseded in part: the user picker was replaced by per-user passwords; the cookie is unchanged.* | [full](docs/decision-log-full.md#2026-11-07--demo-auth-hmac-signed-session-cookie) |
| Snapshot reads, keyset pages, formula from the domain | Reads never show a balance that didn't exist; pages don't skip rows | [full](docs/decision-log-full.md#2026-11-07--owner-read-side-snapshot-reads-keyset-pages-formula-from-the-domain) |
| Approved authorizations are recorded even above available | Increase already approved it; `HOLD_EXCEEDS_AVAILABLE` shows the exposure | [full](docs/decision-log-full.md#2026-11-07--an-approved-authorization-is-recorded-even-above-available-balance) |
| Reversal voids the hold; each refund is its own `CARD_REVERSAL`; refunds on their own card payment are credited unlinked | Partial refunds stack and Visa doesn't always link refunds | [reversal](docs/decision-log-full.md#2026-11-07--card-reversal-vs-refund-purchase-status-after-each), [unlinked](docs/decision-log-full.md#2026-11-07--refunds-on-their-own-card-payment-are-credited-unlinked) |
| Unmodelled card elements fail to Ops and block the whole card payment | A loud stuck card payment beats a quietly wrong ledger. *The Ops tools this waited for (event viewer, retry, investigations) now exist.* | [shapes](docs/decision-log-full.md#2026-11-07--card-lifecycle-shapes-we-dont-model-fail-to-ops), [blocking](docs/decision-log-full.md#2026-11-07--an-unmodelled-element-blocks-its-whole-card-payment-until-ops-resolves-it) |
| Card and ACH simulations call Increase and write nothing | One path changes state, the one real events take. *Their "until the Events API backstop lands" caveat is closed by the poller.* | [cards](docs/decision-log-full.md#2026-11-07--card-simulations-call-increase-from-the-api-state-changes-only-via-the-webhook), [ACH](docs/decision-log-full.md#2026-11-07--our-account-links-to-its-increase-account-simulations-write-nothing) |
| Increase webhooks verified by hand (Standard Webhooks) | Explicit and testable. *Superseded in the deployed app: the sandbox has no subscriptions, so Increase events arrive only through the poller. The route and verifier remain and are tested.* | [full](docs/decision-log-full.md#2026-11-07--increase-webhooks-standard-webhooks-verified-by-hand) |
| Money graph derived from the trace, plain DOM | Short chains read better as a column; no dependency | [full](docs/decision-log-full.md#2026-11-07--money-graph-derived-from-the-trace-plain-dom-links-to-records) |
| Funds check under the account lock; a refused payment stores nothing | Available can't change between check and hold; a retry after funding succeeds | [full](docs/decision-log-full.md#2026-11-07--the-funds-check-runs-under-the-account-lock-a-refused-payment-stores-nothing) |
| `SUBMITTED` status; FedACH submission is a trace step | Pending → Submitted → Completed / Returned, as the owner sees it | [full](docs/decision-log-full.md#2026-11-07--submitted-status-and-a-submitted_to_network-trace-step) |
| ACH transfers without our key or from another account are not ours | *Superseded in part: now IGNORED, not a permanent FAILED* (see key decision 9) | [full](docs/decision-log-full.md#2026-11-07--ach-webhooks-re-fetch-the-transfer-apply-only-the-steps-we-havent) |
| Recipient account number stored, read as last four only | The outbox needs it to retry; masking in the query can't leak by accident | [full](docs/decision-log-full.md#2026-11-07--the-recipient-account-number-is-stored-for-the-outbox-and-shown-as-last-four-only) |
| Outcome counters buffered per process, summed in Postgres | Can't fail or slow the work; no new infrastructure. *The replay counter it anticipated, `replay_mismatch_total`, is wired.* | [full](docs/decision-log-full.md#2026-11-07--outcome-counters-buffered-per-process-summed-in-a-postgres-table) |
| Request latency as a bucket histogram in the counters | Per-route p50/p95 with no new infrastructure | [full](docs/decision-log-full.md#2026-11-07--request-latency-is-a-bucket-histogram-in-the-outcome-counters) |
| Ops retry only from `FAILED`, audited | The only status that needs a person; a second retry is a 409 | [full](docs/decision-log-full.md#2026-11-07--ops-retry-works-only-from-failed) |
| Ops event viewer shows metadata only | Payloads can hold personal data and are never trusted anyway | [full](docs/decision-log-full.md#2026-11-07--ops-event-viewer-metadata-only-keyset-by-received-time) |
| Audit rows written inside the action's transaction | An audit row commits if and only if the action does | [full](docs/decision-log-full.md#2026-11-07--audit-trail-one-writer-inside-the-actions-transaction) |
| Reconciliation runs are a job, one active per provider, in their own worker loop | Double clicks are harmless; a 60 s fetch never stalls events | [job](docs/decision-log-full.md#2026-11-07--reconciliation-runs-are-a-job-on-reconciliation_runs-one-active-run-per-provider), [loop](docs/decision-log-full.md#2026-11-07--reconciliation-runs-in-its-own-loop-in-the-worker-process) |
| Runs on request only; the exceptions queue is each provider's latest successful run | Deterministic demo; no merging across runs | [no schedule](docs/decision-log-full.md#2026-11-07--runs-are-requested-by-ops-only-no-schedule-yet), [queue](docs/decision-log-full.md#2026-11-07--the-exceptions-queue-is-each-providers-latest-successful-run) |
| Provider list reads bounded, scoped to our records | A visible failure beats a silently partial comparison | [full](docs/decision-log-full.md#2026-11-07--provider-list-reads-for-reconciliation) |
| The demo mismatch is reconciled against the fakes | Reproducible without keys; same list code as a real run | [full](docs/decision-log-full.md#2026-11-07--the-demo-mismatch-is-reconciled-in-process-against-the-provider-fakes) |
| CloudFront over an HTTP-only ALB; only `/_next/static/*` cached | HTTPS without a domain; per-user pages must reach the origin. *Superseded in part: the origin policy now also forwards CloudFront headers, and the ALB admits only `X-Origin-Verify`.* | [CloudFront](docs/decision-log-full.md#2026-11-07--cloudfront-in-front-of-an-http-only-alb), [cache](docs/decision-log-full.md#2026-11-07--cloudfront-caches-only-_nextstatic) |
| Client IP from `CloudFront-Viewer-Address` only | Set by CloudFront itself; trusted because only our distribution reaches the ALB | [full](docs/decision-log-full.md#2026-11-07--the-client-ip-is-cloudfront-viewer-address) |
| One Secrets Manager secret per variable; seed passwords reach only the seed task | Nothing secret in the image or task definition. *Superseded in part: the migrate/seed task now also gets the seed passwords and `INCREASE_API_KEY`, not `DATABASE_URL` alone.* | [secrets](docs/decision-log-full.md#2026-11-07--secrets-in-secrets-manager-injected-as-ecs-secrets), [seed](docs/decision-log-full.md#2026-11-07--seeded-passwords-live-in-secrets-manager-and-reach-only-the-seed-task) |
| scrypt parameters | OWASP setting that fits a 1 GB task | [full](docs/decision-log-full.md#2026-11-07--scrypt-with-n215-r8-p3-parameters-stored-with-the-hash) |
| Provider errors checked by name, not `instanceof` | Next gives pages and routes separate module copies | [full](docs/decision-log-full.md#2026-11-07--provider-errors-are-checked-by-name-not-instanceof) |
| Increase bootstrap uses an explicit entity, never creates one | An entity is a legal-person record; code shouldn't invent one | [full](docs/decision-log-full.md#2026-11-07--the-bootstraps-sandbox-account-gets-an-explicit-entity-we-never-create-one) |
| shadcn/ui on Radix, one accent, system dark mode | Accessible primitives; numbers that look trustworthy | [full](docs/decision-log-full.md#2026-11-07--the-ui-is-shadcnui-on-radix-with-one-accent-and-the-systems-dark-mode) |
| What the owner and Ops screens show | Balance first for owners; exceptions first for Ops | [full](docs/decision-log-full.md#2026-11-07--what-the-owner-and-ops-screens-show-and-leave-out) |
| WCAG 2.2 AA, checked with axe and a keyboard pass | The bar for UK and EU financial services | [full](docs/decision-log-full.md#2026-11-07--accessibility-target-wcag-22-aa-checked-with-axe-and-a-scripted-keyboard-pass) |

## Known gaps / what we'd do next

- **No database backups.** The free plan refused backup retention; production needs backups with point-in-time recovery and deletion protection.
- **One Stripe test account is shared by local dev and the deployment**, so local PaymentIntents reach the deployed webhook and its reconciliation. Next: an environment tag in the PaymentIntent metadata, checked by the handler and the reconciler, so other environments' payments end IGNORED ([evidence](docs/sandbox-evidence.md#whats-next)).
- **Replay can't see database transactions.** A settlement row tampered to exactly the two-transaction value passes. Proposed fix: a `db_txid` column defaulting to `txid_current()`, grouping rows by it.
- **No reconciliation schedule.** A missed event is found only when Ops runs one.
- **Ops can't retry IGNORED events.** Reprocessing them after their type gains a handler needs a script.
- **Funding with no PaymentIntent stays PENDING** if Stripe never created one and the client never retries; a worker sweep would retry or expire it.
- **No real-time authorization decisions.** Nothing stops a card spending past available; Increase real-time decisions are the production answer.
- **Partial reversals, increments and multi-capture aren't modelled.** They fail to Ops.
- **Recipient account numbers are plaintext.** Production should tokenize or encrypt them.
- **Accessibility checks aren't in CI** (they ran from a scratch script).
