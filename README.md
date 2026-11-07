# Trace

Business banking built like an observable financial system. **Your bank tells you what your
balance is. Trace tells you why.**

- Plan and write-up: [TRIAL.md](TRIAL.md)
- Architecture and invariants: [CLAUDE.md](CLAUDE.md)
- Decisions: [DECISIONS.md](DECISIONS.md)
- Product spec: [docs/product-spec.md](docs/product-spec.md)
- Sandbox integration evidence (Stripe test mode, Increase sandbox, deployed): [docs/sandbox-evidence.md](docs/sandbox-evidence.md)

## Setup

Needs Node 22.12+ (developed on 26), npm and Docker.

```sh
npm ci
cp .env.example .env    # then set the Stripe test keys and Increase sandbox keys (see below), and the seeded users' passwords
npm run db:up           # Postgres 16 on localhost:5433 with databases trace and trace_test
npm run db:migrate      # apply src/db/migrations to DATABASE_URL
npm run db:seed         # Acme Inc., an owner and an ops user, a $0 USD account, one virtual card
npm run db:seed:demo    # optional, dev only: the $500 fund → $80 authorization → $65 settlement story
```

`db:seed` sets the owner's and the Ops user's passwords from `TRACE_OWNER_PASSWORD` and
`TRACE_OPS_PASSWORD` (at least 12 characters each). Without them it leaves those passwords as they
are (none on a fresh database, so the user can't sign in) and says so; re-running it with new values
rotates them. In production it refuses to run without both. `db:seed:demo` and `demo:reconcile` set
the dev-only test passwords `owner-test-password` and `ops-test-password` (and refuse production).

## Run

```sh
npm run dev             # web app and API on http://localhost:3000 (next picks another port if taken)
npm run worker          # event worker; run several to process in parallel, Ctrl-C / SIGTERM to stop
```

Sign in at `/login` as `owner@acme.test` (the business owner) or `ops@trace.test` (Ops) with the
password you seeded. Every failure is the same "Email or password is incorrect"; after 10 failed
attempts in 15 minutes an email is locked for 15 minutes, and so is a client IP after 50 (`429`).

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
  -d '{"email":"owner@acme.test","password":"<TRACE_OWNER_PASSWORD>"}'
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

Increase events reach the worker two ways, both into the same `external_events` queue: the webhook
(when the sandbox can send one) and the worker's **events poller**, which reads `GET /events` every
5 s for `card_payment.*` and `ach_transfer.*`. An event both deliver is stored once, with both
deliveries recorded (`event_deliveries.source` = `webhook` / `poll`). Without webhooks, a step
reaches the ledger within about 5 s of the simulation call.

1. Put a sandbox API key in `.env` as `INCREASE_API_KEY`. An **anonymous sandbox** (`POST
   https://sandbox.increase.com/groups`, no dashboard) works, with two limits: it can't create event
   subscriptions (409 "Exceeded number of allowed webhook subscriptions 0"), so the poller is the only
   delivery path and `INCREASE_WEBHOOK_SECRET` can be any non-empty value; and it has no default
   entity, so accounts need an `entity_id`. Create one entity by hand, once (`POST /entities`, e.g.
   structure `corporation`; see https://increase.com/documentation/api/entities#create-an-entity).
   Its ids carry a `sandbox_` prefix (`sandbox_card_…`), which the adapter accepts.
2. Link the seeded card to a real sandbox card (once; re-running is a no-op):

   ```sh
   npm run increase:bootstrap   # creates a funded sandbox account + virtual card, stores its id on the seeded card
   ```

   It needs only `DATABASE_URL` and `INCREASE_API_KEY`, never prints the key, and logs the
   Increase entity, account and card ids. The account belongs to `INCREASE_ENTITY_ID` if set, else to
   the only active entity; with none, or several, it stops and says so (it never creates one). The sandbox
   account gets a $100,000 inbound ACH credit so Increase doesn't decline authorizations; that float
   is Increase's, not Trace's ledger.
3. Optional, if your sandbox allows event subscriptions: expose the local app (e.g. `ngrok http
   3000`) and create one in the Increase dashboard (sandbox) pointing at
   `https://<tunnel>/api/webhooks/increase`, ideally limited to `card_payment.created`,
   `card_payment.updated`, `ach_transfer.created` and `ach_transfer.updated`. Put its shared secret
   in `.env` as `INCREASE_WEBHOOK_SECRET` and restart `npm run dev`. Webhooks are verified with
   Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`; 5-minute tolerance).
   Sandbox webhooks are not retried; the poller picks up any that are missed.
4. Keep `npm run worker` running, sign in as the owner (same login as for funding), and drive the card. Each call asks the
   sandbox to simulate a step and returns `202`; the change reaches the ledger only through
   Increase's `card_payment.*` event (polled or webhook) and the worker (watch it in the activity view):

   ```sh
   curl -s -c /tmp/trace.jar localhost:3000/api/auth/login -H 'content-type: application/json' \
     -d '{"email":"owner@acme.test","password":"<TRACE_OWNER_PASSWORD>"}'
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

### Outbound payments (ACH) with the Increase sandbox

Payments use the same Increase sandbox setup as cards. `npm run increase:bootstrap` also links the
seeded account to its Increase sandbox account, which sends the ACH transfers. Re-run it once if
your card was linked before payments existed. Keep `npm run worker` running: it submits payments
(the outbox) and polls `ach_transfer.*` events as well as processing them.

```sh
curl -s -c /tmp/trace.jar localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@acme.test","password":"<TRACE_OWNER_PASSWORD>"}'
curl -s -b /tmp/trace.jar localhost:3000/api/payments -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipientName":"Globex Supplies","accountNumber":"987654321","routingNumber":"101050001","amountCents":10000,"description":"Invoice 2468"}'
```

The response is the `PENDING` payment (account number shown as its last four digits). Available
drops by $100 at once (a pending-payment hold) while the ledger is unchanged. Within a second the
worker sends it to Increase with the idempotency key `payment-<id>` and it becomes `SUBMITTED`, with
the ACH transfer id as its external reference. Then drive the network steps, using the payment's
`id` (each returns `202` and changes nothing until Increase's event is processed):

```sh
P=<payment id>
curl -s -b /tmp/trace.jar -X POST localhost:3000/api/payments/$P/submit   # sent to FedACH (trace step)
curl -s -b /tmp/trace.jar -X POST localhost:3000/api/payments/$P/settle   # COMPLETED: ledger −$100, hold released
curl -s -b /tmp/trace.jar -X POST localhost:3000/api/payments/$P/return \
  -H 'content-type: application/json' -d '{"reason":"account_closed"}'   # returned (needs submit first)
```

A return before settlement makes the payment `RETURNED` and frees the hold. After settlement it
creates a linked `PAYMENT_RETURN` crediting $100 back, and the payment stays `COMPLETED`. The owner
**Payments** page (`/payments`) has the same send form and the lifecycle of each payment. Every
payment opens its money trace.

### Reconciliation and investigations (the core demo mismatch)

Reconciliation compares our transactions with the records each provider's API lists for a time
window. Locally, without provider keys, reproduce the demo story's mismatch against the provider
fakes: Stripe agrees with the $500 funding, Increase reports the $65 settlement as **$80**.

```sh
npm run demo:reconcile   # dev only: seed + demo story, then one reconciliation run of provider "demo" in this process
```

It logs the run id; the run has `MATCHED` (funding) and `AMOUNT_MISMATCH` (card purchase, $65 vs
$80). Then, signed in at `/login` as the Ops user (`ops@trace.test`, password `ops-test-password`):

1. **Reconciliation** (`/ops/reconciliation`) lists the exception: Acme Inc., internal $65,
   external $80, difference +$15. **Open investigation** opens its case.
2. The investigation page shows both sides, likely causes, the purchase's money trace with the
   replay check, the notes timeline and the audit trail. Add a note.
3. **Resolve** with a note and the suggested adjustment (−1500 cents). This posts a new
   `ADJUSTMENT` transaction (−$15, linked to the purchase) through the ledger; nothing is edited.
   Only an amount mismatch on a posted transaction can be adjusted, and only by the amount that
   closes the gap; other exceptions resolve with a note.
   Submitting twice posts once. The owner's purchase page lists the adjustment under **Linked
   transactions**, and the balance goes from $435 to $420.
4. `npm run demo:reconcile` again: the purchase now matches ($65 + $15 adjustment = $80).

Against the real sandboxes, keep `npm run worker` running and use **Reconcile Stripe** /
**Reconcile Increase** on `/ops/reconciliation` (or `POST /api/ops/reconciliation/run
{"provider":"increase"}`; optional `windowStart`/`windowEnd`, default the last 7 days). Increase
runs cover the card and account linked by `npm run increase:bootstrap`; Stripe runs only our
PaymentIntents (with our `transaction_id` metadata). One run per provider is active at a time; a
repeat request returns it. A failed run (e.g. the provider
timed out) shows its error and a **Retry run** button.

## Deploy (AWS)

Trace runs on AWS in `ap-southeast-2` (the only region the trial account allows), with the AWS CLI
profile `corgi`. One image (`Dockerfile`, linux/arm64) serves both processes:

```text
browser ── HTTPS ──▶ CloudFront ── HTTP ──▶ ALB (CloudFront IPs only) ──▶ ECS Fargate trace-web (next start)
                                                                         ECS Fargate trace-worker (worker)
                                                    RDS Postgres 16 (private) ◀──┘
```

```sh
ENV_FILE=.env infra/aws/bootstrap.sh   # once (re-runnable): ECR, log group, security groups, secrets, execution role, RDS, ALB, ECS cluster, CloudFront, budget
infra/aws/deploy.sh                    # each release: build + push the commit's image, migrate, roll trace-web and trace-worker
infra/aws/run-task.sh seed             # once, and after rotating a password: the base seed (Acme Inc., owner + ops users with passwords, $0 account, card)
infra/aws/run-task.sh increase-bootstrap  # once, after the seed and a real trace/INCREASE_API_KEY: link the seeded card and account to Increase
```

- `deploy.sh` refuses a dirty tree (images are tagged by commit), runs `db:migrate` as a one-off
  task and only then updates the services; a service whose new tasks fail health checks rolls back.
- Secrets live in Secrets Manager as `trace/<NAME>` (one per variable in `.env.example`) and reach
  the tasks as ECS `secrets`. Bootstrap copies `STRIPE_SECRET_KEY` from `ENV_FILE`, generates
  `SESSION_SECRET` and the database password, and stores placeholders for
  `STRIPE_WEBHOOK_SECRET`, `INCREASE_API_KEY` and `INCREASE_WEBHOOK_SECRET`. Bootstrap never
  overwrites a secret. To set a real one, then restart the tasks so they read it:

  ```sh
  aws --profile corgi --region ap-southeast-2 secretsmanager put-secret-value \
    --secret-id trace/STRIPE_WEBHOOK_SECRET --secret-string file://whsec.txt   # a file, so the value isn't in shell history
  aws --profile corgi --region ap-southeast-2 ecs update-service --cluster trace --service trace-web --force-new-deployment
  aws --profile corgi --region ap-southeast-2 ecs update-service --cluster trace --service trace-worker --force-new-deployment
  ```

- Sign-in passwords: bootstrap generates `trace/TRACE_OWNER_PASSWORD` and `trace/TRACE_OPS_PASSWORD`
  (20 random characters) and on every run writes them from Secrets Manager to `CREDENTIALS`
  (default `../.demo-credentials`, next to the repo and outside the Docker build context; mode 600),
  which is how the logins are handed out. Only the `trace-migrate` task (migrate and
  seed) receives them; `run-task.sh seed` hashes them into the users. To rotate one, put a new value
  as above and run `infra/aws/run-task.sh seed` (no restart needed).
- CloudFront forwards `CloudFront-Viewer-Address` (origin request policy
  AllViewerAndCloudFrontHeaders-2022-06), the client IP the login throttle counts; bootstrap moves an
  existing distribution onto that policy.
- Only our distribution reaches the app: it sends `X-Origin-Verify` with `trace/CLOUDFRONT_ORIGIN_SECRET`
  (generated by bootstrap), the ALB forwards requests whose header matches and answers 403 to the rest.
  Bootstrap updates an existing distribution and listener in place and waits for the distribution
  to deploy before turning on the 403, so re-running it never drops traffic.
- Stripe webhooks: create an endpoint in the Stripe dashboard (test mode) at
  `https://<cloudfront domain>/api/webhooks/stripe` for `payment_intent.succeeded` and
  `payment_intent.payment_failed`, and store its signing secret as `trace/STRIPE_WEBHOOK_SECRET`.
  Increase: `https://<cloudfront domain>/api/webhooks/increase`, as in the local setup.
- Logs: CloudWatch group `/ecs/trace` (7 days), streams `trace-web/…`, `trace-worker/…`,
  `trace-migrate/…` (`aws logs tail /ecs/trace --follow`).
- `db:seed:demo` and `demo:reconcile` are dev only and are never run here.
- CloudFront caches only `/_next/static/*` (content-hashed build files); everything else reaches the app.

### Reading latency from the UK

The app runs in Sydney, so from the UK most of a request's time is the network (~270 ms per round
trip). API responses (all but webhooks and `/api/health`) carry `Server-Timing: app;dur=<ms>`, the time spent inside the app. In
browser devtools open Network, pick a request and the Timing tab: "Server Timing" shows `app`, and
the rest of "Waiting for server response" is the trip to Sydney and back. Per-route p50/p95 of the
app's own time are on `/ops` under "API latency (server side)" and in `GET /api/ops/metrics`
(`latency`). Request log lines carry `duration_ms`.

## Check

```sh
npm run typecheck
npm run lint
npm test                # unit + integration tests; needs `npm run db:up` (uses DATABASE_URL_TEST)
npm run build
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate` to write a SQL migration into
`src/db/migrations`, review it, commit it, then `npm run db:migrate`.
