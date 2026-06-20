CREATE TABLE "ai_extraction_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"import_job_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_count" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"quality_flags" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_org_id_key" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "ai_extraction_attempts" ADD CONSTRAINT "ai_extraction_attempts_job_fk" FOREIGN KEY ("organization_id","import_job_id") REFERENCES "public"."import_jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_extraction_attempts_org_idx" ON "ai_extraction_attempts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_extraction_attempts_org_created_idx" ON "ai_extraction_attempts" USING btree ("organization_id","created_at");
