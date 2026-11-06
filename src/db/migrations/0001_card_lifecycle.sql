ALTER TYPE "public"."transaction_event_kind" ADD VALUE 'HOLD_EXCEEDS_AVAILABLE';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "counterparty" text;