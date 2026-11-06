CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'FROZEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."card_status" AS ENUM('ACTIVE', 'FROZEN', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."external_event_status" AS ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRY', 'FAILED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."hold_kind" AS ENUM('CARD_AUTHORIZATION', 'PENDING_PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('ACTIVE', 'RELEASED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('FUNDING_CREDIT', 'CARD_SETTLEMENT_DEBIT', 'CARD_REVERSAL_CREDIT', 'PAYMENT_DEBIT', 'PAYMENT_RETURN_CREDIT', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'COMPLETED', 'RETURNED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."transaction_event_kind" AS ENUM('STATUS_CHANGED', 'HOLD_CREATED', 'HOLD_RELEASED', 'HOLD_EXPIRED', 'LEDGER_POSTED', 'SETTLED_AFTER_HOLD_CLOSED');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING', 'AUTHORIZED', 'SETTLED', 'COMPLETED', 'REVERSED', 'RETURNED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('FUNDING', 'CARD_PURCHASE', 'CARD_REVERSAL', 'OUTBOUND_PAYMENT', 'PAYMENT_RETURN', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'OPS');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"ledger_balance_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_currency_usd" CHECK (currency = 'USD')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"previous_state" jsonb,
	"new_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "card_status" DEFAULT 'ACTIVE' NOT NULL,
	"last4" char(4) NOT NULL,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "cards_last4_digits" CHECK ("cards"."last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_event_id" uuid NOT NULL,
	"is_duplicate" boolean NOT NULL,
	"correlation_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "external_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"correlation_id" uuid NOT NULL,
	"transaction_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "hold_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "hold_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "holds_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "holds_amount_positive" CHECK ("holds"."amount_cents" > 0),
	CONSTRAINT "holds_released_at_matches_status" CHECK (("holds"."status" = 'ACTIVE') = ("holds"."released_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"external_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("ledger_entries"."amount_cents" <> 0),
	CONSTRAINT "ledger_entries_currency_usd" CHECK (currency = 'USD')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"provider" text,
	"provider_object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_currency_usd" CHECK (currency = 'USD')
);
--> statement-breakpoint
CREATE TABLE "transaction_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"account_seq" bigint NOT NULL,
	"kind" "transaction_event_kind" NOT NULL,
	"amount_cents" bigint,
	"from_status" text,
	"to_status" text,
	"ledger_delta_cents" bigint DEFAULT 0 NOT NULL,
	"ledger_balance_after_cents" bigint NOT NULL,
	"available_after_cents" bigint NOT NULL,
	"external_event_id" uuid,
	"ledger_entry_id" uuid,
	"provider_ref" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"provider" text,
	"provider_object_id" text,
	"related_transaction_id" uuid,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount_cents" > 0),
	CONSTRAINT "transactions_idempotency_has_hash" CHECK (("transactions"."idempotency_key" IS NULL) = ("transactions"."request_hash" IS NULL)),
	CONSTRAINT "transactions_currency_usd" CHECK (currency = 'USD')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_owner_has_business" CHECK ("users"."role" = 'OPS' OR "users"."business_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_external_event_id_external_events_id_fk" FOREIGN KEY ("external_event_id") REFERENCES "public"."external_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_external_event_id_external_events_id_fk" FOREIGN KEY ("external_event_id") REFERENCES "public"."external_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_external_event_id_external_events_id_fk" FOREIGN KEY ("external_event_id") REFERENCES "public"."external_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_related_transaction_id_transactions_id_fk" FOREIGN KEY ("related_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_business_currency_key" ON "accounts" USING btree ("business_id","currency");--> statement-breakpoint
CREATE INDEX "cards_account_id_idx" ON "cards" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "event_deliveries_external_event_id_idx" ON "event_deliveries" USING btree ("external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_events_provider_event_key" ON "external_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "external_events_due_idx" ON "external_events" USING btree ("next_attempt_at") WHERE "external_events"."status" IN ('RECEIVED', 'RETRY', 'PROCESSING');--> statement-breakpoint
CREATE INDEX "holds_account_active_idx" ON "holds" USING btree ("account_id") WHERE "holds"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_transaction_entry_type_key" ON "ledger_entries" USING btree ("transaction_id","entry_type");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_created_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_account_created_idx" ON "payments" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_object_key" ON "payments" USING btree ("provider","provider_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_events_transaction_seq_key" ON "transaction_events" USING btree ("transaction_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_events_account_seq_key" ON "transaction_events" USING btree ("account_id","account_seq");--> statement-breakpoint
CREATE INDEX "transactions_account_created_idx" ON "transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_account_idempotency_key" ON "transactions" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_object_type_key" ON "transactions" USING btree ("provider","provider_object_id","type");--> statement-breakpoint
CREATE INDEX "transactions_related_transaction_id_idx" ON "transactions" USING btree ("related_transaction_id");