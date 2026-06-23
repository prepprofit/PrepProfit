CREATE TABLE "production_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"production_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"planned_qty" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "production_items_org_production_recipe_key" UNIQUE("organization_id","production_id","recipe_id"),
	CONSTRAINT "production_items_planned_qty_chk" CHECK ("production_items"."planned_qty" between 1 and 100000),
	CONSTRAINT "production_items_sort_order_chk" CHECK ("production_items"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "productions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"reference" text,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"planned_for" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "productions_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "productions_status_chk" CHECK (status IN ('draft', 'planned'))
);
--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_production_fk" FOREIGN KEY ("organization_id","production_id") REFERENCES "public"."productions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_items_org_production_idx" ON "production_items" USING btree ("organization_id","production_id");--> statement-breakpoint
CREATE INDEX "production_items_org_recipe_idx" ON "production_items" USING btree ("organization_id","recipe_id");--> statement-breakpoint
CREATE INDEX "productions_org_idx" ON "productions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "productions_org_deleted_idx" ON "productions" USING btree ("organization_id","deleted_at");--> statement-breakpoint
CREATE INDEX "productions_org_status_planned_idx" ON "productions" USING btree ("organization_id","status","planned_for");--> statement-breakpoint
CREATE INDEX "productions_reference_trgm_idx" ON "productions" USING gin ("reference" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "productions_notes_trgm_idx" ON "productions" USING gin ("notes" gin_trgm_ops);