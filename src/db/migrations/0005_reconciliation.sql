CREATE TYPE "public"."investigation_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL', 'DUPLICATE', 'PENDING_EXTERNAL');--> statement-breakpoint
CREATE TABLE "investigation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_notes_body_length" CHECK (char_length("investigation_notes"."body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"transaction_id" uuid,
	"account_id" uuid,
	"status" "investigation_status" DEFAULT 'OPEN' NOT NULL,
	"opened_by" uuid NOT NULL,
	"resolved_by" uuid,
	"adjustment_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "investigations_record_id_unique" UNIQUE("record_id"),
	CONSTRAINT "investigations_resolved_at_matches_status" CHECK (("investigations"."status" = 'OPEN') = ("investigations"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "reconciliation_status" NOT NULL,
	"reason" text,
	"transaction_type" "transaction_type" NOT NULL,
	"transaction_id" uuid,
	"account_id" uuid,
	"external_id" text,
	"external_ref" text,
	"internal_amount_cents" bigint,
	"external_amount_cents" bigint,
	"internal_status" text,
	"external_status" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" "reconciliation_run_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"matched_count" integer,
	"exception_count" integer,
	"requested_by" uuid,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reconciliation_runs_window_order" CHECK ("reconciliation_runs"."window_end" > "reconciliation_runs"."window_start")
);
--> statement-breakpoint
ALTER TABLE "investigation_notes" ADD CONSTRAINT "investigation_notes_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_notes" ADD CONSTRAINT "investigation_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_record_id_reconciliation_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."reconciliation_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_adjustment_transaction_id_transactions_id_fk" FOREIGN KEY ("adjustment_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_notes_investigation_created_idx" ON "investigation_notes" USING btree ("investigation_id","created_at");--> statement-breakpoint
CREATE INDEX "investigations_status_created_idx" ON "investigations" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "investigations_open_transaction_key" ON "investigations" USING btree ("transaction_id") WHERE "investigations"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "reconciliation_records_run_status_idx" ON "reconciliation_records" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "reconciliation_records_transaction_id_idx" ON "reconciliation_records" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_active_provider_key" ON "reconciliation_runs" USING btree ("provider") WHERE "reconciliation_runs"."status" IN ('PENDING', 'RUNNING');--> statement-breakpoint
CREATE INDEX "reconciliation_runs_due_idx" ON "reconciliation_runs" USING btree ("next_attempt_at") WHERE "reconciliation_runs"."status" IN ('PENDING', 'RUNNING');--> statement-breakpoint
CREATE INDEX "reconciliation_runs_created_idx" ON "reconciliation_runs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_provider_finished_idx" ON "reconciliation_runs" USING btree ("provider","finished_at") WHERE "reconciliation_runs"."status" = 'SUCCEEDED';--> statement-breakpoint
CREATE INDEX "transactions_provider_created_idx" ON "transactions" USING btree ("provider","created_at");