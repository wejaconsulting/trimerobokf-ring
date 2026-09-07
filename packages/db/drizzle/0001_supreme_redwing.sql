CREATE TABLE "integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"sealed_access_token" text,
	"sealed_refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"granted_scopes" jsonb NOT NULL,
	"refresh_token_fingerprint" text NOT NULL,
	"rotation_count" integer DEFAULT 0 NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"initiated_by_user_id" text NOT NULL,
	"return_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "status" text DEFAULT 'disconnected' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "status_code" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "connected_by_user_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "remote_company_name" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "remote_organisation_number" text;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credentials_uq" ON "integration_credentials" USING btree ("tenant_id","client_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_requests_state_uq" ON "oauth_authorization_requests" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_authorization_requests_expiry_idx" ON "oauth_authorization_requests" USING btree ("expires_at");