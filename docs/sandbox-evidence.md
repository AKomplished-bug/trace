# Sandbox integration evidence

On 7 Nov 2026 between 15:34 and 15:36 UTC we ran three fresh flows against the deployed app,
<https://d3aloylres4vpz.cloudfront.net>. Each flow was signed in through the real login
(`POST /api/auth/login`) as the seeded owner, `owner@acme.test`, and as Ops, `ops@trace.test`.
Every id below came from the app's API and was then read back from the provider's own API.

| Flow | Provider | Our transaction | Result | Replay |
|---|---|---|---|---|
| (a) Funding $250.00 | Stripe test mode, webhook | `c0b87dd7-98b5-46e5-98f0-af982f2fd7a5` | SETTLED in 2.4 s | consistent: true |
| (b) Card: authorize $80.00, settle $65.00 | Increase sandbox, Events API poller | `2cff60f5-d237-48b1-a02e-8572d48e254a` | AUTHORIZED, then SETTLED | consistent: true |
| (c) ACH payment $100.00 | Increase sandbox, Events API poller | `cd5f45d7-3464-4701-873f-941f2fdf29f7` (payment `b9c0b8c6-8ea1-4f5b-b051-c79af7c6eebf`) | PENDING, SUBMITTED, COMPLETED | consistent: true |

Account `00000000-0000-4000-8000-000000000021`, Acme Inc. Times are in UTC. Stripe and Increase
timestamps are whole seconds. Ours come from `transaction_events` and `external_events`.

## (a) Stripe funding: `POST /api/funding`

| Step | Our status | Provider id | Provider status (read from Stripe API) | Time (UTC) |
|---|---|---|---|---|
| Request accepted, PaymentIntent created and confirmed (`pm_card_visa`) | PENDING | `pi_3UZBd7GvZ0hDBaj20RLphEln` | `succeeded`, amount 25000 usd, `livemode: false`, metadata `transaction_id` = ours | 15:34:09.099 (Stripe: 15:34:09) |
| Charge | | `ch_3UZBd7GvZ0hDBaj20jU4tnIW` | `succeeded`, `paid: true`, 25000 | 15:34:09 |
| Webhook received at `/api/webhooks/stripe` | event RECEIVED | `evt_3UZBd7GvZ0hDBaj20Ou8ORKk` `payment_intent.succeeded` | `pending_webhooks: 0` (every endpoint acknowledged it) | 15:34:10.333 |
| Worker: LEDGER_POSTED +$250.00, then STATUS_CHANGED | SETTLED | `provider_ref` = the charge id | | 15:34:11.459 |

The balance went from ledger $345.00 / available $345.00 to ledger $595.00 / available $595.00,
which is +$250.00 on both.

## (b) Increase card: `POST /api/cards/:id/authorize`, then `…/settle`

Card `00000000-0000-4000-8000-000000000031`. At Increase it is `sandbox_card_f8gp0xczuusxnnhrpd9y`.

| Step | Our status | Provider id | Provider status (read from Increase API) | Time (UTC) |
|---|---|---|---|---|
| Authorize $80.00 requested (202) | | `sandbox_card_payment_o34njnrcvy0uc3xf8o8w` | card_payment created 15:34:21 | 15:34:21 |
| Authorization element | | `sandbox_card_authorization_ao0esxgd9o93wdhdp1n4` | amount 8000, 15:34:21 | |
| Event polled and processed: HOLD_CREATED $80.00 | AUTHORIZED | `sandbox_event_001m6vaazmq7e8v4schpw2jkk8m` `card_payment.created` | event created 15:34:22 | received 15:34:25.261, applied 15:34:25.856 |
| Settle $65.00 requested (202) | | settlement element `sandbox_card_settlement_swwnv44qpk08v0r3q5iq` | amount 6500, 15:34:38; card_payment state `authorized_amount 8000`, `settled_amount 6500` | 15:34:38 |
| Event polled and processed: LEDGER_POSTED −$65.00, HOLD_RELEASED $80.00, STATUS_CHANGED | SETTLED | `sandbox_event_001m6vabgcwag1fgtj4r0pf1hth` `card_payment.updated` | event created 15:34:39 | received 15:34:40.921, applied 15:34:41.186 |

| Point | Ledger | Card holds | Available |
|---|---|---|---|
| Before | $595.00 | $0.00 | $595.00 |
| After authorization | $595.00 | $80.00 | $515.00 |
| After settlement | $530.00 | $0.00 | $530.00 |

The ledger moved only by the settled $65.00. The $15.00 difference between the authorization and
the settlement was never taken.

## (c) Increase ACH: `POST /api/payments`, then `…/submit` and `…/settle`

| Step | Our status | Provider id | Provider status (read from Increase API) | Time (UTC) |
|---|---|---|---|---|
| Payment created: HOLD_CREATED $100.00 | PENDING | | | 15:35:02.235 |
| Worker submits with `Idempotency-Key: payment-b9c0b8c6-…` | SUBMITTED | `sandbox_ach_transfer_4wwhv17dt4xgfxqqhkdh` | created 15:35:02, `idempotency_key` = `payment-b9c0b8c6-8ea1-4f5b-b051-c79af7c6eebf` | 15:35:02.641 |
| `ach_transfer.created` polled | (no change) | `sandbox_event_001m6vac7gzbyg86cnmz2vgyy10` | event created 15:35:02 | received 15:35:06.994 |
| Simulated submission to FedACH: SUBMITTED_TO_NETWORK | SUBMITTED | `sandbox_event_001m6vacgt38ygpjwvqgkd76nb0` `ach_transfer.updated` | `submission.submitted_at` 15:35:11 | received 15:35:12.712, applied 15:35:14.106 |
| Simulated settlement: LEDGER_POSTED −$100.00, HOLD_RELEASED, STATUS_CHANGED | COMPLETED | `sandbox_event_001m6vacya4whwbw4hjj0m426kv` `ach_transfer.updated` | `settlement.settled_at` 15:35:25 | received 15:35:28.756, applied 15:35:29.384 |
| Second update for the same state | (no change) | `sandbox_event_001m6vacyaehqay06vskpmyv8wj` `ach_transfer.updated` | event created 15:35:26 | processed with no new step |

Increase's top-level `status` stays `submitted` after settlement. Settlement is recorded in the
transfer's `settlement` object, and our COMPLETED status follows from that object.

| Point | Ledger | Pending payments | Available |
|---|---|---|---|
| Before | $530.00 | $0.00 | $530.00 |
| After create (hold) | $530.00 | $100.00 | $430.00 |
| After settlement | $430.00 | $0.00 | $430.00 |

## Replay

`GET /api/transactions/:id/replay` returned `"consistent": true` for all three transactions.
Replay rebuilds each step from the trace rows and checks the result against the recorded
balances, the ledger entry and the hold state. The transaction pages show the same result as the
badge "Replay matches recorded balances".

| Funding | Card | ACH |
|---|---|---|
| ![Funding trace](evidence/funding-trace.png) | ![Card trace](evidence/card-trace.png) | ![ACH trace](evidence/ach-trace.png) |

## Ops view

Ops event viewer (`/ops/events`): the seven events above, each PROCESSED in one attempt with one
delivery. Payloads are withheld.

![Ops event viewer](evidence/ops-events.png)

- **Delivery source.** `event_deliveries.source` records whether a delivery came from a webhook
  or a poll, but the Ops API and UI don't show it yet. The evidence for each path is indirect:
  - Stripe's event reached us 1 s after it was created, and Stripe reports `pending_webhooks: 0`.
  - The Increase account has no event subscriptions (`GET /event_subscriptions` returns 0), and
    its events arrived 3 to 4 s after creation, in line with the 5 s poll.
- **Idempotent dedupe.** Counters since the deploy:
  - `increase_events_polled_total{outcome="already_polled"}` = 9,769 overlap re-reads, none of
    which was recorded or applied again. `{outcome="new"}` = 25.
  - `webhooks_received_total{provider="stripe",outcome="duplicate"}` = 1. That duplicate is
    event `evt_trace_selftest_c6f0e8b7b9ed`: 2 deliveries, stored once, IGNORED.
- **Counters for these flows** (`GET /api/ops/metrics`, including earlier runs today):
  - `funding_outcomes_total{settled}` 3
  - `card_steps_total{AUTHORIZATION,applied}` 2 and `{SETTLEMENT,applied}` 2
  - `payment_submissions_total{submitted}` 2
  - `payment_steps_total{NETWORK_SUBMITTED,applied}` 2 and `{COMPLETE,applied}` 2
  - Events by status: PROCESSED 15, FAILED 1, IGNORED 14. Payment backlog: 0 pending, 0 given up.

![Ops dashboard](evidence/ops-dashboard.png)

The one FAILED event on the dashboard, `evt_3UZ8SsGvZ0hDBaj204FVJuYb` from 12:11 UTC, is not part
of these flows. Its PaymentIntent names a transaction id this database doesn't have
(`FundingNotFoundError`), so it is surfaced to Ops rather than dropped.

## What is mocked or limited

- **Sandboxes only.** Stripe runs in test mode (`livemode: false`, `pm_card_visa`) and Increase in
  its sandbox. No real money moves.
- **Card and ACH steps are simulated.** The routes `/api/cards/:id/{authorize,settle}` and
  `/api/payments/:id/{submit,settle}` call Increase's sandbox simulation endpoints. They write
  nothing themselves: our books change only when the resulting Increase event arrives and the
  worker applies it.
- **Increase events come from polling, not webhooks.** The anonymous Increase sandbox has no
  webhook subscriptions, so the worker polls `GET /events` every 5 s. The polled events go
  through the same ingestion path as a webhook body would. The Increase webhook route exists and
  is tested, but it receives nothing in this deployment.
- **Stripe webhooks hit the deployed app.** A Stripe test-mode endpoint
  `we_1UZ3v0GvZ0hDBaj2SRv7Lf4a` points at
  `https://d3aloylres4vpz.cloudfront.net/api/webhooks/stripe` for `payment_intent.succeeded` and
  `payment_intent.payment_failed`. No `stripe listen` is involved.
- **The app is hosted in Sydney** (AWS ap-southeast-2, behind CloudFront). From the UK, each
  request adds about 270 ms of round trip. The slower simulation routes, around 0.4 to 2.4 s
  server side, are mostly waiting on Increase.
- **Screenshots** were taken in UTC, logged in from saved session cookies, with no password on
  screen.

## How to reproduce

```sh
B=https://d3aloylres4vpz.cloudfront.net
curl -s -c jar -H 'content-type: application/json' -d '{"email":"owner@acme.test","password":"<owner password>"}' $B/api/auth/login
curl -s -b jar -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{"amountCents":25000}' $B/api/funding
curl -s -b jar -H 'content-type: application/json' -d '{"amountCents":8000}' $B/api/cards/00000000-0000-4000-8000-000000000031/authorize
# transaction id: GET $B/api/transactions (items[].providerObjectId = the cardPaymentId), a few seconds later
curl -s -b jar -H 'content-type: application/json' -d '{"transactionId":"<id>","amountCents":6500}' $B/api/cards/00000000-0000-4000-8000-000000000031/settle
curl -s -b jar -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipientName":"Globex Supplies","accountNumber":"987654321","routingNumber":"101050001","amountCents":10000}' $B/api/payments
curl -s -b jar -X POST $B/api/payments/<payment id>/submit   # once the payment is SUBMITTED
curl -s -b jar -X POST $B/api/payments/<payment id>/settle
curl -s -b jar $B/api/transactions/<id>/replay               # "consistent": true
```

Then open `/transactions/<id>` as the owner, and `/ops` and `/ops/events` as Ops.
