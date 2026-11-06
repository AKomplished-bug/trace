# Trace — Product & Engineering Specification

## 0. Executive summary

**Trace** is a business banking platform built around one core idea:

> **Every dollar should be traceable, explainable, and debuggable.**

Traditional banking software tells a business what its current balance is and lists transactions. Trace goes further: it models financial activity as a sequence of state transitions and external events, then lets the user or an operations team understand **why** a balance changed, **where** money moved, and **where** internal and external records disagree.

Trace is intentionally not a generic neobank, a generic AI banking assistant, or a generic spend-management product.

Its differentiating product concept is:

> **Financial observability.**

Think of the mental model of Datadog / GitHub / a debugger, but applied to business money.

The product has two primary roles:

1. **Business owner** — funds an account, uses a card, sends payments, and understands available money.
2. **Operations user** — investigates discrepancies, reconciles internal records against external providers, detects duplicate/missing/mismatched events, and understands exactly how a transaction reached its current state.

---

# 1. Product thesis

## Problem

Business financial activity passes through multiple systems:

```text
Business owner
    ↓
Our banking platform
    ↓
External payment/banking provider
    ↓
Provider events/webhooks
    ↓
Our transaction/state system
    ↓
Our ledger
    ↓
Displayed balance
```

A mismatch can occur at any layer.

Examples:

- A card authorization is $80 but settles at $65.
- The same settlement webhook arrives twice.
- An external transaction exists but our system has not processed it.
- Our internal transaction says $65 while an external report says $80.
- A payment is returned after initially appearing successful.
- A card transaction is reversed after settlement.

A conventional banking UI mostly exposes the final result.

Trace exposes the **causal chain**.

## Product promise

For every important money movement, Trace should answer:

- What happened?
- When did it happen?
- What external event caused it?
- What state did the transaction move from/to?
- How did it affect the ledger?
- How did it affect available balance?
- Which external provider record corresponds to it?
- Was the event processed once or more than once?
- Does the internal record reconcile with the external record?
- If something is wrong, where exactly did the discrepancy appear?

---

# 2. Target customer

Initial target:

**Small/medium businesses and startups that need a business operating account but also care deeply about understanding and controlling their cash movement.**

The initial product should remain small.

Do not build payroll, accounting, loans, taxes, multi-currency, investment products, physical cards, complex permissions, or a full banking-as-a-service platform.

The first version should focus on:

- one business
- one business account
- one virtual card
- one payment method
- USD
- funding
- card transactions
- outbound payments
- transaction history
- reconciliation
- operational investigation

---

# 3. Product principles

## 3.1 Every dollar has a story

A transaction should not be an isolated row.

It should have a lifecycle and trace.

Example:

```text
$80 card authorization
        ↓
$80 hold
        ↓
$65 settlement
        ↓
$80 hold released
        ↓
$65 ledger debit
        ↓
$65 balance impact
```

## 3.2 Ledger is the financial source of truth

Do not treat a mutable `account.balance` field as the ultimate financial truth.

Financial history should be represented through ledger entries.

Balances can be cached/materialized for performance, but they must be derivable from the ledger.

## 3.3 Holds are not settled money

A card authorization/hold is not the same thing as a settled debit.

Example:

```text
Initial ledger balance:      $500
Card authorization:          $80
Ledger balance:              $500
Available balance:           $420
```

If the merchant settles at $65:

```text
Ledger balance:              $435
Hold released:               $80
Available balance:           $435
```

Do not permanently debit $80 and then separately add $15. Model authorization/holds and settlement correctly.

## 3.4 External events are untrusted input

External providers can:

- retry events
- deliver events out of order
- send duplicates
- fail to send an event
- send an event whose financial values differ from expectations

Therefore webhook/event processing must be idempotent and auditable.

## 3.5 Exceptions are first-class product objects

The 95% happy path should be simple.

The remaining 5% should be easy to investigate.

A discrepancy should not just appear as:

> `ERROR`

It should tell Ops:

> **What differs, where it differs, and the likely reason.**

---

# 4. Primary user journeys

## Journey A — Business funding

1. Business signs in.
2. Business account is created.
3. Business funds the account using a sandbox payment provider.
4. External provider confirms successful payment.
5. Webhook/event is received.
6. Funding transaction is created.
7. Ledger is updated.
8. Available balance increases.
9. Transaction appears in activity.
10. Transaction detail shows the external reference and event timeline.

Example:

```text
Funding request: $500

External provider:
payment succeeded

Trace:
funding event received
        ↓
event validated
        ↓
idempotency checked
        ↓
ledger +$500
        ↓
balance = $500
```

---

# 5. Journey B — Card authorization → settlement

This is the primary transaction lifecycle.

## Initial state

```text
Ledger balance:    $500
Available balance: $500
```

## Authorization

Customer makes an $80 card purchase.

```text
Card authorization: $80

Ledger balance:    $500
Available balance: $420
Pending holds:     $80
```

Important:

**Ledger does not decrease at authorization.**

## Settlement

Merchant later settles for $65.

```text
Settlement: $65

Ledger balance:    $435
Hold released:     $80
Available balance: $435
```

The transaction should preserve the full lifecycle:

```text
AUTHORIZED $80
      ↓
HOLD_CREATED $80
      ↓
SETTLED $65
      ↓
HOLD_RELEASED $80
```

The UI should clearly explain the distinction between authorization and settlement.

---

# 6. Journey C — Card reversal

If a settled card transaction is later reversed:

```text
Original settlement: -$65

Reversal: +$65

Net financial impact: $0
```

The original transaction must remain visible.

Do not overwrite the original transaction.

The reversal should be a new event/entry linked to the original transaction.

This preserves history and makes the lifecycle auditable.

---

# 7. Journey D — Duplicate settlement event

External provider sends:

```text
event_123
settlement $65
```

Then sends the same event again:

```text
event_123
settlement $65
```

Expected result:

```text
First event:
processed → ledger -$65

Second event:
detected as duplicate → no financial change
```

The system should record that the duplicate was received.

Ops should be able to see:

```text
Duplicate event detected
External event ID: event_123
Original processing time: ...
Duplicate received at: ...
Financial effect: none
```

---

# 8. Journey E — Outbound payment

Business sends $100 to an external recipient.

Lifecycle:

```text
PENDING
   ↓
COMPLETED
```

or:

```text
PENDING
   ↓
RETURNED
```

The payment should have:

- internal payment ID
- external provider ID
- amount
- currency
- recipient
- status
- created timestamp
- state transition history
- ledger impact
- external event references

Do not assume a payment is immediately final.

---

# 9. Journey F — Operations reconciliation

Ops opens the reconciliation dashboard.

Example:

```text
RECONCILIATION

Matched:       1,248
Mismatched:        3
Missing:           2
Duplicates:        7
```

For each external/internal record pair:

### Matched

```text
Internal amount:    $65
External amount:    $65

Internal status:    SETTLED
External status:    SUCCEEDED

External ID:        pi_123
Internal ID:        TX_18492

✓ Amount matches
✓ Currency matches
✓ Status matches
✓ Reference matches

RECONCILED
```

### Mismatched

```text
Internal amount:    $65
External amount:    $80

Difference:         $15

Status:
Internal = SETTLED
External = SUCCEEDED

⚠ RECONCILIATION EXCEPTION
```

The system should link the discrepancy back to the transaction event timeline.

---

# 10. Signature feature — Money Trace

Every financial transaction gets a **Trace view**.

Example:

```text
TX_18492
AWS
Final amount: $65
Status: SETTLED

TIMELINE

10:41:02
Authorization created
Amount: $80

10:41:08
Hold created
Amount: $80

10:42:31
Settlement received
Amount: $65

10:42:32
Hold released
Amount: $80

10:42:32
Ledger entry posted
Amount: -$65

10:42:33
Balance materialized
$435
```

The transaction should expose:

- internal transaction ID
- provider ID
- external event IDs
- timestamps
- state transitions
- ledger entries
- balance impact
- reconciliation status

---

# 11. Signature feature — Replay

Provide a visual transaction replay.

The user can step through events and see financial state change.

Example:

```text
START

Ledger       $500
Available    $500

↓ Authorization $80

Ledger       $500
Available    $420

↓ Settlement $65

Ledger       $435
Available    $435

↓ Hold released

Ledger       $435
Available    $435
```

The replay is explanatory, not merely decorative.

It should demonstrate exactly why the final balance exists.

---

# 12. Signature feature — Balance explanation

When the user sees:

```text
Available to spend
$435
```

they should be able to inspect the calculation.

Example:

```text
Ledger balance                 $500
Pending card holds             -$80
Pending payments                 $0
Other reserved funds             $0
-----------------------------------
Available balance               $420
```

After settlement:

```text
Ledger balance                 $435
Pending card holds               $0
Pending payments                 $0
-----------------------------------
Available balance               $435
```

The exact formula should reflect the chosen accounting model. Do not hard-code assumptions into the UI without documenting them.

---

# 13. Operations investigation

Ops should have a dedicated investigation experience.

Example:

```text
Investigation #INV-1024

Account:
Acme Inc.

Issue:
External settlement mismatch

Internal:
$65

External:
$80

Difference:
$15

Related transaction:
TX_18492

Related provider object:
pi_123

Timeline:
...

Potential causes:
- settlement amount differs from authorization
- external record has not reached final state
- duplicate/misordered event
- provider reconciliation delay
```

Actions:

- inspect transaction
- inspect raw external event
- compare internal/external state
- replay transaction
- retry reconciliation
- mark resolved
- add investigation note

Do not allow Ops to silently mutate financial history.

If a manual correction mechanism is included, it must create a new auditable adjustment rather than modifying historical ledger entries.

---

# 14. Core data model

Use PostgreSQL.

Suggested entities:

## Business

```text
id
name
created_at
```

## Account

```text
id
business_id
currency
status
created_at
```

## Card

```text
id
account_id
status
last4
provider_id
created_at
```

## Transaction

Represents a business-level financial transaction.

```text
id
account_id
type
status
amount
currency
provider
provider_object_id
related_transaction_id
created_at
updated_at
```

Types may include:

```text
FUNDING
CARD_PURCHASE
CARD_REVERSAL
OUTBOUND_PAYMENT
PAYMENT_RETURN
ADJUSTMENT
```

## Card authorization / hold

```text
id
transaction_id
amount
status
authorized_at
expires_at
released_at
```

## Payment

```text
id
account_id
transaction_id
recipient
amount
currency
status
provider_object_id
created_at
updated_at
```

## Ledger entry

Immutable financial record.

```text
id
account_id
transaction_id
entry_type
amount
currency
created_at
```

Use a consistent sign convention.

For example:

```text
credit = positive
debit = negative
```

## External event

```text
id
provider
external_event_id
event_type
payload
received_at
processed_at
processing_status
error
```

Critical constraint:

```text
UNIQUE(provider, external_event_id)
```

This is the primary idempotency mechanism for external events.

## Audit event

```text
id
actor_type
actor_id
action
entity_type
entity_id
previous_state
new_state
metadata
created_at
```

## Reconciliation record

```text
id
transaction_id
external_record_id
internal_amount
external_amount
internal_status
external_status
status
difference
created_at
resolved_at
resolution_note
```

---

# 15. Ledger design

The ledger should be append-only.

Do not edit historical entries.

If something must be corrected:

```text
Original entry
      ↓
Correction entry
      ↓
New derived balance
```

Example:

```text
Original settlement:
-$80

Correction:
+$15

Net:
-$65
```

The UI should preserve both records.

This is critical for auditability.

---

# 16. Event processing architecture

Use an asynchronous event processing model.

```text
External provider
       ↓
Webhook endpoint
       ↓
Validate / authenticate
       ↓
Persist raw external event
       ↓
Idempotency check
       ↓
Queue / worker
       ↓
Domain event processor
       ↓
State transition
       ↓
Ledger entries
       ↓
Materialized balance
       ↓
Reconciliation
```

Important:

**Persist the external event before performing business processing.**

This allows retries/reprocessing and makes debugging easier.

---

# 17. Idempotency

Idempotency must exist at multiple levels.

## External event idempotency

Unique:

```text
provider + external_event_id
```

## Internal command idempotency

For operations such as creating a payment, accept an idempotency key.

Example:

```text
POST /payments
Idempotency-Key: abc123
```

Repeated requests with the same key should not create multiple payments.

## Ledger idempotency

A single domain event should never generate the same financial effect twice.

Ledger entries should have a unique reference to the originating event/transaction where appropriate.

---

# 18. Reconciliation architecture

Reconciliation should compare:

```text
Internal transaction records
          ↕
External provider records
```

Comparison dimensions:

- amount
- currency
- status
- provider ID
- timestamps
- transaction type

Potential statuses:

```text
MATCHED
AMOUNT_MISMATCH
STATUS_MISMATCH
MISSING_INTERNAL
MISSING_EXTERNAL
DUPLICATE
PENDING_EXTERNAL
```

The system should distinguish:

**“We don't have this yet”**

from:

**“We have it and it disagrees.”**

---

# 19. External integrations

The product must use at least two external services with sandbox/test environments.

## Integration 1 — Stripe

Use Stripe test mode for payment/funding and relevant webhook lifecycle events.

No real money.

Stripe should be accessed through an internal adapter/interface rather than scattered directly throughout domain code.

Example abstraction:

```text
PaymentProvider
  createPayment()
  retrievePayment()
  refundPayment()
  handleWebhook()
```

Stripe adapter implements the interface.

Store provider IDs and raw webhook events.

## Integration 2 — Second financial/banking sandbox

Use a second provider that supports the chosen workflow and can be used entirely in test/sandbox mode.

Do not couple the product to the provider prematurely.

The second integration should ideally provide external financial/payment/account records that can participate in reconciliation.

Before implementation, verify:

- sandbox availability
- test credentials
- webhook support
- API limits
- no-cost test operation
- ability to demonstrate evidence
- relevance to Track 3

Document the final provider choice in the decision log.

---

# 20. Provider abstraction

Never make the domain layer depend directly on Stripe.

Use:

```text
domain/
    payments/
    ledger/
    cards/
    reconciliation/

integrations/
    stripe/
    second_provider/
```

Provider-specific payloads should be converted into internal domain events.

For example:

```text
Stripe:
payment_intent.succeeded
        ↓
Internal:
FUNDING_CONFIRMED
```

or:

```text
Stripe:
charge.succeeded
        ↓
Internal:
CARD_SETTLEMENT_RECEIVED
```

The internal domain should not know Stripe-specific semantics except where necessary.

---

# 21. API design

Prefer clear REST APIs.

Example:

```text
POST   /auth/login

GET    /business
GET    /account
GET    /account/balance
GET    /transactions
GET    /transactions/:id
GET    /transactions/:id/timeline
GET    /transactions/:id/replay

POST   /funding
POST   /cards
POST   /cards/:id/authorize
POST   /cards/:id/settle
POST   /payments
GET    /payments/:id

GET    /ops/reconciliation
GET    /ops/reconciliation/:id
POST   /ops/reconciliation/:id/retry
POST   /ops/investigations
GET    /ops/investigations/:id
```

Exact endpoint naming can be adjusted during implementation.

---

# 22. UI / screen specification

## Business owner

### 1. Login

Simple demo authentication.

### 2. Dashboard

Show:

- available balance
- ledger balance
- pending amount
- recent activity
- card status
- quick actions

Primary CTA:

**View money trace**

### 3. Account activity

Filters:

- date
- transaction type
- status
- amount

### 4. Transaction detail

Show:

- amount
- merchant/recipient
- status
- balance impact
- external provider
- provider ID
- event timeline
- ledger entries
- reconciliation status
- replay

### 5. Card

Show:

- card status
- last four digits
- recent card activity
- pending holds

### 6. Payments

Show:

- recipient
- amount
- status
- lifecycle
- external reference

### 7. Balance explanation

A dedicated view or expandable panel explaining:

```text
Ledger balance
+
available credits
-
pending holds
-
reserved/pending payments
=
Available balance
```

---

# 23. Operations UI

### Ops dashboard

Metrics:

```text
Transactions
Matched
Mismatched
Missing
Duplicates
Pending
```

### Reconciliation queue

Each exception should show:

```text
Business
Transaction
Internal amount
External amount
Difference
Status
Age
```

### Investigation page

Show:

- internal state
- external state
- event timeline
- raw events
- ledger entries
- discrepancy
- likely cause
- actions
- audit history

### Event viewer

Allow Ops to inspect:

```text
Provider
Event ID
Event type
Received timestamp
Processing timestamp
Processing result
Raw payload
```

Raw payload should be read-only.

---

# 24. Visual/product direction

The UI should feel like:

**modern fintech + observability tooling.**

Avoid generic banking gradients and excessive cards.

Use a clean, information-dense interface.

Important visual patterns:

- timelines
- event streams
- state badges
- balance decomposition
- transaction graphs
- reconciliation indicators
- expandable technical details

The transaction detail page is the hero experience.

The user should immediately understand:

> “This product knows what happened to my money.”

---

# 25. “Money graph”

For transactions with multiple lifecycle events, provide a causal visualization.

Example:

```text
External authorization
        │
        ▼
Internal hold
        │
        ▼
External settlement
        │
        ▼
Internal ledger entry
        │
        ▼
Balance update
```

Nodes should link to underlying records.

The visualization should not obscure the raw timeline; both should exist.

---

# 26. Replay implementation

Replay should be deterministic.

Given:

```text
Initial account state
+
ordered domain events
```

the system should be able to reconstruct the expected state.

Pseudo-concept:

```text
state = initial_state

for event in events:
    state = apply(state, event)
```

Do not implement replay by mutating production records.

Replay is read-only simulation.

---

# 27. Financial correctness rules

These rules must be explicit and tested.

### Authorization

Does not change ledger balance.

May reduce available balance through a hold.

### Settlement

Creates the actual ledger debit/credit.

Releases associated hold.

### Reversal

Creates an offsetting financial effect.

Does not erase original transaction.

### Duplicate external event

No duplicate financial effect.

### Returned payment

Reverse/offset the original payment impact according to the chosen model.

### Pending payment

Must not be treated as completed money movement.

### Historical transaction

Must never be silently overwritten.

---

# 28. Edge cases to test

At minimum:

1. Authorization for $80 settles for $65.
2. Authorization expires without settlement.
3. Duplicate settlement webhook.
4. Settlement webhook arrives twice.
5. Reversal after settlement.
6. Payment remains pending.
7. Payment completes.
8. Payment returns.
9. External event arrives after a retry.
10. External transaction exists but internal record is missing.
11. Internal record exists but external record is missing.
12. Internal and external amounts differ.
13. Internal and external statuses differ.
14. Duplicate payment creation request.
15. Out-of-order event delivery where practical.

---

# 29. Security / safety

This is a fictional sandbox product.

Use:

- fictional customer data
- test credentials
- sandbox providers
- USD
- no real money

Never commit provider secrets.

Use environment variables:

```text
DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SECOND_PROVIDER_API_KEY
SECOND_PROVIDER_WEBHOOK_SECRET
```

Do not expose secret keys in frontend code.

---

# 30. Observability

Trace itself should be observable.

Provide structured logs for:

- webhook received
- event persisted
- event deduplicated
- event processing started
- state transition
- ledger entry created
- reconciliation executed
- reconciliation mismatch
- payment created
- payment failed

Each request/event should have a correlation ID.

Example:

```text
correlation_id=abc123
event_id=evt_123
transaction_id=TX_18492
```

This should make debugging easy.

---

# 31. Error handling

Do not swallow financial errors.

An event that cannot be processed should become:

```text
PROCESSING_FAILED
```

with:

- error
- retry count
- timestamp
- event ID
- transaction ID

It should be possible for Ops to retry processing safely.

Retries must be idempotent.

---

# 32. Testing strategy

Prioritize financial correctness over UI test coverage.

Unit tests:

- balance calculation
- authorization/hold logic
- settlement
- reversal
- payment state transitions
- idempotency
- reconciliation
- replay

Integration tests:

- provider webhook
- funding flow
- card lifecycle
- payment lifecycle
- reconciliation

Critical invariant:

> Processing the same external event twice must produce the same financial state as processing it once.

---

# 33. Architecture choice

Use a **modular monolith**.

Do not build microservices.

Suggested structure:

```text
apps/
  web/
  api/
  worker/

packages/
  domain/
  database/
  integrations/
  shared/
```

Or an equivalent structure appropriate to the chosen stack.

Suggested stack:

### Frontend

- Next.js
- TypeScript
- Tailwind
- component library if useful

### Backend

Prefer:

- TypeScript
- Node.js
- Fastify/Nest/Express, or another well-structured framework

Python is also acceptable if there is a strong reason.

### Database

PostgreSQL.

### Async processing

Use a simple queue/worker.

Redis is acceptable if genuinely useful, but do not introduce infrastructure without need.

### Deployment

Use a simple cloud deployment with:

- frontend
- API
- worker
- PostgreSQL

Avoid unnecessary Kubernetes/microservice infrastructure.

---

# 34. Product scope

## Must build

### Business

- login
- business/account
- funding
- balance
- card
- card purchase lifecycle
- outbound payment
- transaction history
- transaction detail
- money trace
- replay

### Operations

- reconciliation dashboard
- transaction investigation
- external event viewer
- duplicate detection
- mismatch detection
- audit trail

### Integrations

- Stripe sandbox
- second sandbox provider

---

# 35. Nice-to-have

Only build after the core is excellent.

Possible additions:

- transaction search
- filters
- CSV export
- notification on reconciliation failure
- risk flags
- financial anomaly detection
- “why did my balance change?” natural-language explanation
- what-if simulation
- transaction graph
- scheduled reconciliation

---

# 36. Explicitly out of scope

Do not build:

- real banking connectivity
- real money movement
- real physical cards
- loans
- investments
- payroll
- accounting/tax integrations
- multi-currency
- FX
- complex role/permission systems
- KYC/AML
- production-grade fraud detection
- full accounting double-entry framework unless needed for correctness
- microservice architecture
- mobile application

The goal is a small but deeply coherent product.

---

# 37. Differentiation

Trace should not compete on number of banking features.

Its differentiation is:

### 1. Financial observability

Money has an event trail.

### 2. Explainable balances

Users can understand why their available balance is what it is.

### 3. Transaction replay

A financial transaction can be reconstructed step-by-step.

### 4. Operational debugging

Ops can diagnose discrepancies rather than merely seeing them.

### 5. Provider-aware reconciliation

Internal state and external provider state are linked.

### 6. Immutable history

Corrections preserve the original record.

---

# 38. Product language

Avoid calling things:

```text
Logs
Errors
Database records
Webhook dumps
```

to the business user.

Use:

```text
Money trace
Activity
Balance explanation
Transaction history
External record
Investigation
Reconciliation
```

Ops can have more technical detail.

---

# 39. Core product narrative

The product should tell this story:

> **Your bank tells you what your balance is. Trace tells you why.**

Then demonstrate:

```text
$500
 ↓
$80 authorization
 ↓
$65 settlement
 ↓
$80 hold released
 ↓
$435 final balance
```

Then intentionally demonstrate an external mismatch:

```text
Internal: $65
External: $80

↓
Trace detects mismatch

↓
Ops opens investigation

↓
Replay shows lifecycle

↓
Records are compared

↓
Exception is resolved
```

That should be the core demo.

---

# 40. Development priorities

Build in this exact order unless implementation reality requires adjustment.

## Phase 1 — Domain model

Implement:

- Business
- Account
- Transaction
- Ledger
- External Event
- Audit Event

Write financial invariants first.

## Phase 2 — Funding

Build:

```text
Stripe test payment
    ↓
Webhook
    ↓
External event
    ↓
Funding transaction
    ↓
Ledger
    ↓
Balance
```

## Phase 3 — Card lifecycle

Build:

```text
Authorization
    ↓
Hold
    ↓
Settlement
    ↓
Hold release
```

Then reversal.

## Phase 4 — Idempotency

Implement duplicate event handling.

Test it aggressively.

## Phase 5 — Payments

Implement:

```text
PENDING
    ↓
COMPLETED

or

PENDING
    ↓
RETURNED
```

## Phase 6 — Money Trace

Build timeline + balance explanation + replay.

## Phase 7 — Ops

Build reconciliation + investigation.

## Phase 8 — Second provider

Integrate and use it meaningfully in reconciliation.

## Phase 9 — Polish

Make the core user experience exceptional.

---

# 41. Decision log

Maintain a short dated decision log in the repository.

Format:

```md
## YYYY-MM-DD — Decision title

**Decision**
What was chosen.

**Why**
Reasoning.

**Alternatives**
What was considered.

**Tradeoff**
What was sacrificed.
```

Important decisions to record:

- why Track 3
- why Trace/product thesis
- why modular monolith
- why PostgreSQL
- why Stripe
- second provider choice
- ledger model
- authorization vs settlement model
- idempotency strategy
- reconciliation model
- what was deliberately excluded
- any financial assumptions

---

# 42. Product quality bar

Do not optimize for feature count.

A small number of workflows should feel extremely solid.

The following should be nearly impossible to misunderstand:

1. Funding money.
2. Spending money.
3. Seeing available balance.
4. Understanding a card hold.
5. Understanding settlement.
6. Seeing a reversal.
7. Sending a payment.
8. Investigating a discrepancy.
9. Replaying a transaction.
10. Understanding exactly where the money went.

---

# 43. Definition of done

The product is done when a new user can:

```text
Create business
      ↓
Create/fund account
      ↓
See $500
      ↓
Make $80 card transaction
      ↓
See $420 available
      ↓
Settle for $65
      ↓
See $435 available
      ↓
Open transaction
      ↓
Replay lifecycle
      ↓
Understand every balance transition
```

And an Ops user can:

```text
Open reconciliation
      ↓
Find discrepancy
      ↓
Open transaction
      ↓
Compare internal/external records
      ↓
Inspect raw event
      ↓
Replay transaction
      ↓
Understand cause
      ↓
Resolve with audit trail
```

If these flows work beautifully, the product succeeds.

---

# 44. Final product statement

**Trace**

> **A business banking platform built like an observable financial system.**
>
> Track every financial event. Explain every balance. Reconcile every external record. Debug every discrepancy.

**Core idea:**

> **Every dollar has a story. Trace tells it.**
