ALTER TABLE "approval_decisions" ADD COLUMN "actor_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "approved_payload_hash" text;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD COLUMN "fortnox_voucher_id" text;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD COLUMN "fortnox_reference" text;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD COLUMN "approval_decision_id" text;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD COLUMN "submission_error" text;--> statement-breakpoint
ALTER TABLE "client_accounting_policies" ADD COLUMN "auto_book_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "close_runs" ADD COLUMN "data_source" text DEFAULT 'mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "close_runs" ADD COLUMN "data_source_label" text;