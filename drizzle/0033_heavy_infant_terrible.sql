CREATE TABLE "stock_count_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stock_count_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"counted_canonical" numeric(12, 2) NOT NULL,
	"system_canonical" numeric(12, 2),
	"movement_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_items_org_count_ingredient_key" UNIQUE("organization_id","stock_count_id","ingredient_id"),
	CONSTRAINT "stock_count_items_counted_chk" CHECK ("stock_count_items"."counted_canonical" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"storage_area_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" text,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "stock_counts_status_chk" CHECK (status IN ('draft', 'committed')),
	CONSTRAINT "stock_counts_committed_at_chk" CHECK (("stock_counts"."committed_at" is not null) = ("stock_counts"."status" = 'committed'))
);
--> statement-breakpoint
CREATE TABLE "storage_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "storage_areas_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "storage_areas_name_chk" CHECK (char_length(btrim("storage_areas"."name")) between 1 and 80),
	CONSTRAINT "storage_areas_sort_order_chk" CHECK ("storage_areas"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "storage_area_id" text;--> statement-breakpoint
ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_count_fk" FOREIGN KEY ("organization_id","stock_count_id") REFERENCES "public"."stock_counts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_storage_area_fk" FOREIGN KEY ("organization_id","storage_area_id") REFERENCES "public"."storage_areas"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_items_org_count_idx" ON "stock_count_items" USING btree ("organization_id","stock_count_id");--> statement-breakpoint
CREATE INDEX "stock_count_items_org_movement_idx" ON "stock_count_items" USING btree ("organization_id","movement_id");--> statement-breakpoint
CREATE INDEX "stock_counts_org_idx" ON "stock_counts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "stock_counts_org_status_idx" ON "stock_counts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "stock_counts_org_area_idx" ON "stock_counts" USING btree ("organization_id","storage_area_id");--> statement-breakpoint
CREATE INDEX "storage_areas_org_idx" ON "storage_areas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "storage_areas_org_sort_idx" ON "storage_areas" USING btree ("organization_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_areas_org_name_active_key" ON "storage_areas" USING btree ("organization_id",lower("name")) WHERE "storage_areas"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_areas_org_default_key" ON "storage_areas" USING btree ("organization_id") WHERE "storage_areas"."is_default" and "storage_areas"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_storage_area_fk" FOREIGN KEY ("organization_id","storage_area_id") REFERENCES "public"."storage_areas"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_org_area_ingredient_idx" ON "inventory_movements" USING btree ("organization_id","storage_area_id","ingredient_id");--> statement-breakpoint
-- Sprint 12c (D2): seed one immutable "Main" default area per existing org. Runs
-- BEFORE scripts/migrate.ts re-applies rlsStatements, so FORCE RLS is not yet active
-- on the new table and these INSERTs are not blocked. Historical inventory_movements
-- stay storage_area_id NULL and reconcile into this default bucket (= defaultId OR NULL).
INSERT INTO "storage_areas" ("id", "organization_id", "name", "is_default", "sort_order")
SELECT gen_random_uuid(), "organization_id", 'Main', true, 0
FROM "organization_settings"
ON CONFLICT DO NOTHING;