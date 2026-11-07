CREATE TABLE "login_throttles" (
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "login_throttles_scope_key_hash_pk" PRIMARY KEY("scope","key_hash"),
	CONSTRAINT "login_throttles_scope" CHECK ("login_throttles"."scope" IN ('email', 'ip'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;