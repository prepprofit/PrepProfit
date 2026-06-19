CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"entity" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'parsed' NOT NULL,
	"source_filename" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"normalized_rows" jsonb,
	"issues" jsonb,
	"idempotency_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_org_idempotency_key" UNIQUE("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "import_jobs_org_idx" ON "import_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "import_jobs_org_status_idx" ON "import_jobs" USING btree ("organization_id","status");