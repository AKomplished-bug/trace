ALTER TYPE "public"."payment_status" ADD VALUE 'SUBMITTED' BEFORE 'COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."transaction_event_kind" ADD VALUE 'SUBMITTED_TO_NETWORK';--> statement-breakpoint
ALTER TYPE "public"."transaction_status" ADD VALUE 'SUBMITTED' BEFORE 'SETTLED';