CREATE TABLE "accounting_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"period_key" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"status" text NOT NULL,
	"fortnox_locked_through" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"review_item_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"proposal_id" text,
	"kind" text NOT NULL,
	"decided_by_user_id" text NOT NULL,
	"comment" text,
	"edited_payload" jsonb,
	"shadow_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text,
	"close_run_id" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" text NOT NULL,
	"input_refs" jsonb NOT NULL,
	"rule_version" text,
	"prompt_version" text,
	"model_provider" text,
	"model_name" text,
	"tool_call" text,
	"proposed_payload" jsonb,
	"approved_payload" jsonb,
	"result" text NOT NULL,
	"fortnox_id" text,
	"error_code" text,
	"error_message" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_proposal_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"account" integer NOT NULL,
	"debit" numeric(20, 0) NOT NULL,
	"credit" numeric(20, 0) NOT NULL,
	"description" text NOT NULL,
	"cost_center" text,
	"project" text,
	"vat_code" text
);
--> statement-breakpoint
CREATE TABLE "booking_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"finding_id" text,
	"status" text NOT NULL,
	"decision_level" text NOT NULL,
	"decision_score" real NOT NULL,
	"decision_reasons" jsonb NOT NULL,
	"transaction_date" text NOT NULL,
	"series" text NOT NULL,
	"description" text NOT NULL,
	"rationale" text NOT NULL,
	"simulated_fortnox_payload" jsonb NOT NULL,
	"simulated_fortnox_endpoint" text NOT NULL,
	"simulated_payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_accounting_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"materiality_threshold" numeric(20, 0) NOT NULL,
	"automation_amount_limit" numeric(20, 0) NOT NULL,
	"cost_center_required_accounts" jsonb NOT NULL,
	"project_required_accounts" jsonb NOT NULL,
	"require_documentation_for_input_vat" boolean DEFAULT true NOT NULL,
	"history_window_months" integer DEFAULT 12 NOT NULL,
	"amount_deviation_threshold" real DEFAULT 0.5 NOT NULL,
	"vat_rates" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"organisation_number" text NOT NULL,
	"fortnox_company_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "close_run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"step_order" integer NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "close_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"period_id" text NOT NULL,
	"period_key" text NOT NULL,
	"status" text NOT NULL,
	"shadow_mode" boolean DEFAULT true NOT NULL,
	"rule_set_version" text NOT NULL,
	"decision_model_version" text NOT NULL,
	"correlation_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"finding_id" text,
	"status" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"subject" jsonb NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"description" text NOT NULL,
	"rationale" text NOT NULL,
	"suggested_action" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"decision_level" text NOT NULL,
	"decision_score" real NOT NULL,
	"decision_reasons" jsonb NOT NULL,
	"requires_consultant" boolean NOT NULL,
	"blocking" boolean NOT NULL,
	"deduplication_key" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"merged_from_rule_ids" jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organisation_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_records" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"period_key" text,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"credential_ref" text,
	"writes_enabled" boolean DEFAULT false NOT NULL,
	"healthy" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_source_records" (
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"source_key" text NOT NULL,
	"close_run_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_source_records_tenant_id_client_id_source_key_pk" PRIMARY KEY("tenant_id","client_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"reconciliation_id" text NOT NULL,
	"reference" text NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"matched" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"account" integer NOT NULL,
	"period_key" text NOT NULL,
	"ledger_balance" numeric(20, 0) NOT NULL,
	"external_balance" numeric(20, 0),
	"difference" numeric(20, 0) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"close_run_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"status" text NOT NULL,
	"assigned_to_user_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"external_ref" text,
	"file_name" text,
	"received" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"period_key" text NOT NULL,
	"transaction_date" text NOT NULL,
	"account" integer NOT NULL,
	"debit" numeric(20, 0) NOT NULL,
	"credit" numeric(20, 0) NOT NULL,
	"description" text NOT NULL,
	"cost_center" text,
	"project" text,
	"vat_code" text,
	"voucher_id" text NOT NULL,
	"voucher_row_id" text NOT NULL,
	"supplier_number" text,
	"customer_number" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "periods_tenant_client_period_uq" ON "accounting_periods" USING btree ("tenant_id","client_id","period_key");--> statement-breakpoint
CREATE INDEX "approval_decisions_finding_idx" ON "approval_decisions" USING btree ("tenant_id","finding_id");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("tenant_id","correlation_id");--> statement-breakpoint
CREATE INDEX "audit_events_run_idx" ON "audit_events" USING btree ("tenant_id","close_run_id","occurred_at");--> statement-breakpoint
CREATE INDEX "proposal_rows_proposal_idx" ON "booking_proposal_rows" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposals_run_idx" ON "booking_proposals" USING btree ("tenant_id","close_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_tenant_client_uq" ON "client_accounting_policies" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "client_rules_tenant_client_idx" ON "client_rules" USING btree ("tenant_id","client_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_orgnr_uq" ON "clients" USING btree ("tenant_id","organisation_number");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_run_step_uq" ON "close_run_steps" USING btree ("close_run_id","step_key");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_idempotency_uq" ON "close_run_steps" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "close_runs_tenant_client_idx" ON "close_runs" USING btree ("tenant_id","client_id","period_key");--> statement-breakpoint
CREATE INDEX "customer_requests_run_idx" ON "customer_requests" USING btree ("tenant_id","close_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_dedup_uq" ON "findings" USING btree ("tenant_id","close_run_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "findings_queue_idx" ON "findings" USING btree ("tenant_id","client_id","close_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_records_uq" ON "imported_records" USING btree ("tenant_id","client_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "imported_records_period_idx" ON "imported_records" USING btree ("tenant_id","client_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_uq" ON "integration_connections" USING btree ("tenant_id","client_id","kind");--> statement-breakpoint
CREATE INDEX "reconciliation_items_idx" ON "reconciliation_items" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliations_uq" ON "reconciliations" USING btree ("tenant_id","close_run_id","account");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_finding_uq" ON "review_items" USING btree ("tenant_id","finding_id");--> statement-breakpoint
CREATE INDEX "review_items_queue_idx" ON "review_items" USING btree ("tenant_id","close_run_id","status");--> statement-breakpoint
CREATE INDEX "source_documents_tenant_client_idx" ON "source_documents" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_row_uq" ON "transactions" USING btree ("tenant_id","client_id","voucher_row_id");--> statement-breakpoint
CREATE INDEX "transactions_period_account_idx" ON "transactions" USING btree ("tenant_id","client_id","period_key","account");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uq" ON "users" USING btree ("tenant_id","email");