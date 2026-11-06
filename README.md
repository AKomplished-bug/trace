# Trace

Business banking built like an observable financial system. **Your bank tells you what your
balance is. Trace tells you why.**

- Plan and write-up: [TRIAL.md](TRIAL.md)
- Architecture and invariants: [CLAUDE.md](CLAUDE.md)
- Decisions: [DECISIONS.md](DECISIONS.md)
- Product spec: [docs/product-spec.md](docs/product-spec.md)

## Setup

Needs Node 22.12+ (developed on 26), npm and Docker.

```sh
npm ci
cp .env.example .env    # then set the Stripe test keys and Increase sandbox keys (see below)
npm run db:up           # Postgres 16 on localhost:5433 with databases trace and trace_test
npm run db:migrate      # apply src/db/migrations to DATABASE_URL
npm run db:seed         # Acme Inc., an owner and an ops user, a $0 USD account, one virtual card
npm run db:seed:demo    # optional, dev only: the $500 fund → $80 authorization → $65 settlement story
```

## Run

```sh
npm run dev             # web app and API on http://localhost:3000 (next picks another port if taken)
npm run worker          # event worker; run several to process in parallel, Ctrl-C / SIGTERM to stop
```

### Funding with Stripe test mode

Funding uses a Stripe **test-mode** account (no real money). The web app and worker refuse to
start without `STRIPE_SECRET_KEY` (test keys only; `sk_live_` is rejected) and
`STRIPE_WEBHOOK_SECRET`. Put the test secret key in `.env` as `STRIPE_SECRET_KEY=sk_test_…`, then forward webhooks to the local app with the
[Stripe CLI](https://docs.stripe.com/stripe-cli):

```sh
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the `whsec_…` secret it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, restart `npm run dev`,
and keep `npm run worker` running. Then sign in as the seeded owner (the session cookie goes into
a cookie jar) and fund the demo account with $500:

```sh
curl -s -c /tmp/trace.jar localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"userId":"00000000-0000-4000-8000-000000000011"}'
curl -s -b /tmp/trace.jar localhost:3000/api/funding -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amountCents":50000}'
```

The response is the `PENDING` transaction. Stripe sends `payment_intent.succeeded`; the webhook
stores it, the worker re-fetches the PaymentIntent and settles the transaction (ledger +$500).
`payment_intent.created` and `charge.*` events are stored and marked `IGNORED`. `stripe listen`
forwards every event on the account; anything else without a handler is retried and ends `FAILED`,
so pass `--events payment_intent.succeeded,payment_intent.payment_failed` to keep the queue
clean on a shared test account. Use port 3000 or whichever port `npm run dev` printed.

### Card lifecycle with the Increase sandbox

Cards use the [Increase](https://increase.com/documentation) **sandbox** (no real money; the
adapter only ever calls `sandbox.increase.com`). The web app and worker refuse to start without
`INCREASE_API_KEY` and `INCREASE_WEBHOOK_SECRET`.

1. Put a sandbox API key in `.env` as `INCREASE_API_KEY`.
2. Link the seeded card to a real sandbox card (once; re-running is a no-op):

   ```sh
   npm run increase:bootstrap   # creates a funded sandbox account + virtual card, stores its id on the seeded card
   ```

   It needs only `DATABASE_URL` and `INCREASE_API_KEY`, never prints the key, and logs the
   Increase account and card ids. The sandbox account gets a $100,000 inbound ACH credit so
   Increase doesn't decline authorizations; that float is Increase's, not Trace's ledger.
3. Expose the local app (e.g. `ngrok http 3000`) and create an event subscription in the Increase
   dashboard (sandbox) pointing at `https://<tunnel>/api/webhooks/increase`, ideally limited to
   `card_payment.created` and `card_payment.updated`. Put its shared secret in `.env` as
   `INCREASE_WEBHOOK_SECRET` and restart `npm run dev`. Webhooks are verified with Standard
   Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`; 5-minute tolerance).
   **Sandbox webhooks are not retried**, so one missed while the app is down is lost until the
   Events API backstop lands.
4. Keep `npm run worker` running, sign in as the owner (same login as for funding), and drive the card. Each call asks the
   sandbox to simulate a step and returns `202`; the change reaches the ledger only through
   Increase's `card_payment.*` webhook and the worker (watch it in the activity view):

   ```sh
   curl -s -c /tmp/trace.jar localhost:3000/api/auth/login -H 'content-type: application/json' \
     -d '{"userId":"00000000-0000-4000-8000-000000000011"}'
   CARD=00000000-0000-4000-8000-000000000031
   curl -s -b /tmp/trace.jar localhost:3000/api/cards/$CARD/authorize -H 'content-type: application/json' \
     -d '{"amountCents":8000,"merchant":"FIGMA.COM"}'
   # once the purchase shows AUTHORIZED (GET /api/transactions), use its id:
   curl -s -b /tmp/trace.jar localhost:3000/api/cards/$CARD/settle -H 'content-type: application/json' \
     -d '{"transactionId":"<purchase id>","amountCents":6500}'
   ```

   `reverse {transactionId, amountCents?}` voids an unsettled authorization in full (sending
   `amountCents` before settlement is refused with `422 partial_reversal_not_supported`) or
   refunds a settled one, in part if `amountCents` is given (partial refunds stack); `expire {transactionId}` expires the
   authorization. Other Increase event categories the flow emits (`pending_transaction.*`,
   `transaction.created`, …) are stored and marked `IGNORED`.

## Check

```sh
npm run typecheck
npm run lint
npm test                # unit + integration tests; needs `npm run db:up` (uses DATABASE_URL_TEST)
npm run build
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate` to write a SQL migration into
`src/db/migrations`, review it, commit it, then `npm run db:migrate`.
