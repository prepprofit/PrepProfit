CREATE TABLE "menu_extras" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"menu_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"hours" numeric(10, 2),
	"hourly_cents" integer,
	"amount_cents" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_extras_shape_chk" CHECK (("menu_extras"."kind" = 'work' and "menu_extras"."hours" is not null and "menu_extras"."hourly_cents" is not null and "menu_extras"."hours" >= 0 and "menu_extras"."hours" <= 100000 and "menu_extras"."hourly_cents" >= 0 and "menu_extras"."hourly_cents" <= 10000000 and "menu_extras"."amount_cents" is null) or ("menu_extras"."kind" = 'expense' and "menu_extras"."amount_cents" is not null and "menu_extras"."amount_cents" >= 0 and "menu_extras"."amount_cents" <= 100000000 and "menu_extras"."hours" is null and "menu_extras"."hourly_cents" is null)),
	CONSTRAINT "menu_extras_sort_order_chk" CHECK ("menu_extras"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "output_quantity" numeric(14, 4) DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "output_unit" text DEFAULT 'portion' NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "size_description" text;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "finished_weight_grams" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "price_basis" text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "labour_hours" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "labour_hourly_cents" integer;--> statement-breakpoint
-- Existing products keep their meaning: N portions, priced per portion (no reinterpretation).
UPDATE "menus" SET "output_quantity" = "portions", "output_unit" = 'portion', "price_basis" = 'unit';--> statement-breakpoint
ALTER TABLE "menu_extras" ADD CONSTRAINT "menu_extras_menu_fk" FOREIGN KEY ("organization_id","menu_id") REFERENCES "public"."menus"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_extras_org_menu_idx" ON "menu_extras" USING btree ("organization_id","menu_id");--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_output_chk" CHECK ("menus"."output_quantity" > 0 and "menus"."output_unit" in ('g', 'kg', 'piece', 'cake', 'portion'));--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_price_basis_chk" CHECK (("menus"."output_unit" in ('g', 'kg')) = ("menus"."price_basis" = 'kg'));--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_finished_weight_chk" CHECK ("menus"."finished_weight_grams" is null or ("menus"."finished_weight_grams" > 0 and "menus"."output_unit" not in ('g', 'kg')));--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_labour_chk" CHECK (("menus"."labour_hours" is null and "menus"."labour_hourly_cents" is null) or ("menus"."labour_hours" is not null and "menus"."labour_hourly_cents" is not null and "menus"."labour_hours" >= 0 and "menus"."labour_hours" <= 100000 and "menus"."labour_hourly_cents" >= 0 and "menus"."labour_hourly_cents" <= 10000000));