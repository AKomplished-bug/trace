-- account_number / routing_number are NOT NULL without a default: no released code has ever written
-- a payments row, so the table is empty in every environment and the running code never inserts one.
ALTER TABLE "accounts" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "account_number" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "routing_number" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "submit_claim_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "next_submit_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_submit_error" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "submit_gave_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payments_submit_due_idx" ON "payments" USING btree ("next_submit_at") WHERE "payments"."status" = 'PENDING' AND "payments"."submit_gave_up_at" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_provider_id_unique" UNIQUE("provider_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_number_digits" CHECK ("payments"."account_number" ~ '^[0-9]{4,17}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_routing_number_digits" CHECK ("payments"."routing_number" ~ '^[0-9]{9}$');