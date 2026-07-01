CREATE TABLE "profit_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"finding_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"explanation" jsonb,
	"explanation_model" text,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_insights_org_fingerprint_key" UNIQUE("organization_id","fingerprint")
);
--> statement-breakpoint
CREATE INDEX "profit_insights_org_idx" ON "profit_insights" USING btree ("organization_id");