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
cp .env.example .env    # local defaults work as-is; provider keys are optional for now
npm run db:up           # Postgres 16 on localhost:5433 with databases trace and trace_test
npm run db:migrate      # apply src/db/migrations to DATABASE_URL
npm run db:seed         # Acme Inc., an owner and an ops user, a $0 USD account, one virtual card
```

## Run

```sh
npm run dev             # web app and API on http://localhost:3000 (next picks another port if taken)
npm run worker          # event worker; run several to process in parallel, Ctrl-C / SIGTERM to stop
```

## Check

```sh
npm run typecheck
npm run lint
npm test                # unit + integration tests; needs `npm run db:up` (uses DATABASE_URL_TEST)
npm run build
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate` to write a SQL migration into
`src/db/migrations`, review it, commit it, then `npm run db:migrate`.
