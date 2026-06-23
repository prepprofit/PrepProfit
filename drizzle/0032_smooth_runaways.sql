CREATE TABLE "sale_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_recipe_id" text,
	"item_menu_id" text,
	"item_ingredient_id" text,
	"item_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"ingredient_qty_canonical" numeric(12, 2),
	"unit_net_cents" integer NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"net_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"gross_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sale_items_item_kind_chk" CHECK (item_kind IN ('recipe', 'menu', 'ingredient')),
	CONSTRAINT "sale_items_quantity_chk" CHECK ("sale_items"."quantity" between 1 and 100000),
	CONSTRAINT "sale_items_unit_net_chk" CHECK ("sale_items"."unit_net_cents" >= 0),
	CONSTRAINT "sale_items_tax_rate_chk" CHECK ("sale_items"."tax_rate_bps" between 0 and 10000),
	CONSTRAINT "sale_items_sort_order_chk" CHECK ("sale_items"."sort_order" >= 0),
	CONSTRAINT "sale_items_money_chk" CHECK ("sale_items"."net_cents" >= 0 and "sale_items"."tax_cents" >= 0 and "sale_items"."gross_cents" >= 0
        and "sale_items"."net_cents" = "sale_items"."quantity" * "sale_items"."unit_net_cents"
        and "sale_items"."gross_cents" = "sale_items"."net_cents" + "sale_items"."tax_cents"),
	CONSTRAINT "sale_items_source_shape_chk" CHECK ((
        ("sale_items"."item_kind" = 'recipe' and "sale_items"."item_recipe_id" is not null and "sale_items"."item_menu_id" is null and "sale_items"."item_ingredient_id" is null and "sale_items"."ingredient_qty_canonical" is null)
        or ("sale_items"."item_kind" = 'menu' and "sale_items"."item_menu_id" is not null and "sale_items"."item_recipe_id" is null and "sale_items"."item_ingredient_id" is null and "sale_items"."ingredient_qty_canonical" is null)
        or ("sale_items"."item_kind" = 'ingredient' and "sale_items"."item_ingredient_id" is not null and "sale_items"."item_recipe_id" is null and "sale_items"."item_menu_id" is null and "sale_items"."ingredient_qty_canonical" is not null and "sale_items"."ingredient_qty_canonical" > 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sale_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"net_cents" integer,
	"tax_cents" integer,
	"gross_cents" integer,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"stock_moved" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_status_chk" CHECK (status IN ('draft', 'posted', 'void')),
	CONSTRAINT "sales_money_presence_chk" CHECK (("sales"."net_cents" is not null) = ("sales"."status" in ('posted', 'void'))
        and ("sales"."tax_cents" is not null) = ("sales"."status" in ('posted', 'void'))
        and ("sales"."gross_cents" is not null) = ("sales"."status" in ('posted', 'void'))),
	CONSTRAINT "sales_money_nonneg_chk" CHECK ("sales"."net_cents" is null
        or ("sales"."net_cents" >= 0 and "sales"."tax_cents" >= 0 and "sales"."gross_cents" >= 0)),
	CONSTRAINT "sales_money_sum_chk" CHECK ("sales"."gross_cents" is null or "sales"."gross_cents" = "sales"."net_cents" + "sales"."tax_cents"),
	CONSTRAINT "sales_posted_at_chk" CHECK (("sales"."posted_at" is not null) = ("sales"."status" in ('posted', 'void'))),
	CONSTRAINT "sales_voided_at_chk" CHECK (("sales"."voided_at" is not null) = ("sales"."status" = 'void')),
	CONSTRAINT "sales_stock_moved_chk" CHECK ("sales"."stock_moved" = false or "sales"."status" in ('posted', 'void'))
);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_recipe_fk" FOREIGN KEY ("organization_id","item_recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_menu_fk" FOREIGN KEY ("organization_id","item_menu_id") REFERENCES "public"."menus"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_ingredient_fk" FOREIGN KEY ("organization_id","item_ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_items_org_sale_idx" ON "sale_items" USING btree ("organization_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_org_recipe_idx" ON "sale_items" USING btree ("organization_id","item_recipe_id");--> statement-breakpoint
CREATE INDEX "sale_items_org_menu_idx" ON "sale_items" USING btree ("organization_id","item_menu_id");--> statement-breakpoint
CREATE INDEX "sale_items_org_ingredient_idx" ON "sale_items" USING btree ("organization_id","item_ingredient_id");--> statement-breakpoint
CREATE INDEX "sales_org_idx" ON "sales" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sales_org_date_idx" ON "sales" USING btree ("organization_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_org_status_date_idx" ON "sales" USING btree ("organization_id","status","sale_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_org_date_active_key" ON "sales" USING btree ("organization_id","sale_date") WHERE "sales"."status" <> 'void';