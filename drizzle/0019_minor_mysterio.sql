ALTER TABLE "organization_settings" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "deletion_requested_by" text;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "deletion_reason" text;