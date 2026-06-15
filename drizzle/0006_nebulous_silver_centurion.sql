ALTER TABLE "ingredients" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ingredients_org_deleted_idx" ON "ingredients" USING btree ("organization_id","deleted_at");--> statement-breakpoint
CREATE INDEX "recipes_org_deleted_idx" ON "recipes" USING btree ("organization_id","deleted_at");