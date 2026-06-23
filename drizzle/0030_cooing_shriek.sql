CREATE TABLE "production_consumptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"production_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"ingredient_name" text NOT NULL,
	"dimension" text NOT NULL,
	"qty_canonical" numeric(12, 2) NOT NULL,
	"movement_id" text,
	CONSTRAINT "production_consumptions_org_production_ingredient_key" UNIQUE("organization_id","production_id","ingredient_id"),
	CONSTRAINT "production_consumptions_qty_chk" CHECK ("production_consumptions"."qty_canonical" > 0)
);
--> statement-breakpoint
CREATE TABLE "production_recipe_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"production_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_name" text NOT NULL,
	"planned_qty" integer NOT NULL,
	"cost_per_portion_cents" integer NOT NULL,
	"line_cost_cents" integer NOT NULL,
	CONSTRAINT "production_recipe_snapshots_planned_qty_chk" CHECK ("production_recipe_snapshots"."planned_qty" between 1 and 100000),
	CONSTRAINT "production_recipe_snapshots_cost_chk" CHECK ("production_recipe_snapshots"."cost_per_portion_cents" >= 0 and "production_recipe_snapshots"."line_cost_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "productions" DROP CONSTRAINT "productions_status_chk";--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "cost_total_cents" integer;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "stock_moved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_production_fk" FOREIGN KEY ("organization_id","production_id") REFERENCES "public"."productions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_movement_fk" FOREIGN KEY ("organization_id","movement_id") REFERENCES "public"."inventory_movements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_recipe_snapshots" ADD CONSTRAINT "production_recipe_snapshots_production_fk" FOREIGN KEY ("organization_id","production_id") REFERENCES "public"."productions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_consumptions_org_production_idx" ON "production_consumptions" USING btree ("organization_id","production_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_consumptions_org_movement_key" ON "production_consumptions" USING btree ("organization_id","movement_id") WHERE "production_consumptions"."movement_id" is not null;--> statement-breakpoint
CREATE INDEX "production_recipe_snapshots_org_production_idx" ON "production_recipe_snapshots" USING btree ("organization_id","production_id");--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_completed_at_chk" CHECK ((completed_at IS NOT NULL) = (status IN ('completed', 'voided')));--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_voided_at_chk" CHECK ((voided_at IS NOT NULL) = (status = 'voided'));--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_cost_total_chk" CHECK ((cost_total_cents IS NOT NULL) = (status IN ('completed', 'voided')));--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_cost_total_nonneg_chk" CHECK (cost_total_cents IS NULL OR cost_total_cents >= 0);--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_stock_moved_chk" CHECK (stock_moved = false OR status IN ('completed', 'voided'));--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_status_chk" CHECK (status IN ('draft', 'planned', 'completed', 'voided'));