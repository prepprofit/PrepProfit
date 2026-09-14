CREATE TABLE "menu_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_folders_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "menu_folders_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "menu_ingredient_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"menu_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"quantity" numeric(12, 4) NOT NULL,
	"unit" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_ingredient_items_org_menu_ingredient_key" UNIQUE("organization_id","menu_id","ingredient_id"),
	CONSTRAINT "menu_ingredient_items_quantity_chk" CHECK ("menu_ingredient_items"."quantity" > 0 and "menu_ingredient_items"."quantity" <= 100000000),
	CONSTRAINT "menu_ingredient_items_unit_chk" CHECK ("menu_ingredient_items"."unit" in ('g', 'kg', 'ml', 'l', 'piece')),
	CONSTRAINT "menu_ingredient_items_sort_order_chk" CHECK ("menu_ingredient_items"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_quantity_chk";--> statement-breakpoint
ALTER TABLE "menu_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "menu_items" ALTER COLUMN "quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "unit" text DEFAULT 'portion' NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "portions" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "vat_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "menu_ingredient_items" ADD CONSTRAINT "menu_ingredient_items_menu_fk" FOREIGN KEY ("organization_id","menu_id") REFERENCES "public"."menus"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_ingredient_items" ADD CONSTRAINT "menu_ingredient_items_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_folders_org_idx" ON "menu_folders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "menu_ingredient_items_org_menu_idx" ON "menu_ingredient_items" USING btree ("organization_id","menu_id");--> statement-breakpoint
CREATE INDEX "menu_ingredient_items_org_ingredient_idx" ON "menu_ingredient_items" USING btree ("organization_id","ingredient_id");--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_folder_fk" FOREIGN KEY ("organization_id","folder_id") REFERENCES "public"."menu_folders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menus_org_folder_idx" ON "menus" USING btree ("organization_id","folder_id");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_unit_chk" CHECK ("menu_items"."unit" in ('portion', 'g', 'kg'));--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_quantity_chk" CHECK ("menu_items"."quantity" > 0 and "menu_items"."quantity" <= 100000000);--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_portions_chk" CHECK ("menus"."portions" between 1 and 100000);--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_vat_rate_chk" CHECK ("menus"."vat_rate_bps" is null or ("menus"."vat_rate_bps" >= 0 and "menus"."vat_rate_bps" <= 10000));