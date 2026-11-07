-- audit_events.correlation_id is NOT NULL without a default: no released code has ever written an
-- audit_events row, so the table is empty in every environment and the running code never inserts one.
CREATE TABLE "metric_counters" (
	"name" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_counters_name_labels_pk" PRIMARY KEY("name","labels")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "correlation_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "external_events_received_idx" ON "external_events" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "external_events_status_received_idx" ON "external_events" USING btree ("status","received_at","id");--> statement-breakpoint
CREATE INDEX "transaction_events_external_event_id_idx" ON "transaction_events" USING btree ("external_event_id");