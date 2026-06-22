CREATE TABLE "menu_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"menu_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_items_org_menu_recipe_key" UNIQUE("organization_id","menu_id","recipe_id"),
	CONSTRAINT "menu_items_quantity_chk" CHECK ("menu_items"."quantity" between 1 and 1000),
	CONSTRAINT "menu_items_sort_order_chk" CHECK ("menu_items"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"selling_price_cents" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "menus_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "menus_selling_price_chk" CHECK ("menus"."selling_price_cents" is null or "menus"."selling_price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_fk" FOREIGN KEY ("organization_id","menu_id") REFERENCES "public"."menus"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_items_org_menu_idx" ON "menu_items" USING btree ("organization_id","menu_id");--> statement-breakpoint
CREATE INDEX "menu_items_org_recipe_idx" ON "menu_items" USING btree ("organization_id","recipe_id");--> statement-breakpoint
CREATE INDEX "menus_org_idx" ON "menus" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "menus_org_name_idx" ON "menus" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "menus_org_deleted_idx" ON "menus" USING btree ("organization_id","deleted_at");--> statement-breakpoint
CREATE INDEX "menus_name_trgm_idx" ON "menus" USING gin ("name" gin_trgm_ops);