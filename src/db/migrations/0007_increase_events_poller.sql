CREATE TABLE "provider_cursors" (
	"provider" text PRIMARY KEY NOT NULL,
	"last_event_created_at" timestamp with time zone,
	"last_external_event_id" text,
	"claim_token" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD COLUMN "source" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_deliveries_one_poll_key" ON "event_deliveries" USING btree ("external_event_id") WHERE "event_deliveries"."source" = 'poll';--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_source" CHECK ("event_deliveries"."source" IN ('webhook', 'poll'));