ALTER TABLE "ingredient_suppliers" ADD COLUMN "units_per_pack" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredient_suppliers" ADD COLUMN "supplier_product_name" text;--> statement-breakpoint
ALTER TABLE "ingredient_suppliers" ADD COLUMN "supplier_sku" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_price_basis" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_price_includes_vat" boolean;--> statement-breakpoint
ALTER TABLE "ingredient_suppliers" ADD CONSTRAINT "ingredient_suppliers_units_per_pack_chk" CHECK ("ingredient_suppliers"."units_per_pack" > 0);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_default_price_basis_chk" CHECK ("suppliers"."default_price_basis" is null or "suppliers"."default_price_basis" in ('pack', 'inner', 'priced'));