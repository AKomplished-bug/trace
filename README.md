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
cp .env.example .env    # then set the two Stripe test keys (see below); the rest works as-is
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
and keep `npm run worker` running. Then fund the demo account with $500:

```sh
curl -s localhost:3000/api/funding -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amountCents":50000}'
```

The response is the `PENDING` transaction. Stripe sends `payment_intent.succeeded`; the webhook
stores it, the worker re-fetches the PaymentIntent and settles the transaction (ledger +$500).
`payment_intent.created` and `charge.*` events are stored and marked `IGNORED`. `stripe listen`
forwards every event on the account; anything else without a handler is retried and ends `FAILED`,
so pass `--events payment_intent.succeeded,payment_intent.payment_failed` to keep the queue
clean on a shared test account. Use port 3000 or whichever port `npm run dev` printed.

## Check

```sh
npm run typecheck
npm run lint
npm test                # unit + integration tests; needs `npm run db:up` (uses DATABASE_URL_TEST)
npm run build
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate` to write a SQL migration into
`src/db/migrations`, review it, commit it, then `npm run db:migrate`.
