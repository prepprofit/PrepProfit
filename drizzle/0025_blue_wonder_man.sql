CREATE TABLE "ingredient_suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"pack_size" numeric(12, 2),
	"pack_unit" text,
	"pack_price_cents" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_suppliers_org_ingredient_supplier_key" UNIQUE("organization_id","ingredient_id","supplier_id"),
	CONSTRAINT "ingredient_suppliers_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "ingredient_suppliers_pack_size_chk" CHECK ("ingredient_suppliers"."pack_size" is null or "ingredient_suppliers"."pack_size" > 0),
	CONSTRAINT "ingredient_suppliers_pack_price_chk" CHECK ("ingredient_suppliers"."pack_price_cents" is null or "ingredient_suppliers"."pack_price_cents" >= 0),
	CONSTRAINT "ingredient_suppliers_price_requires_pack_chk" CHECK ("ingredient_suppliers"."pack_price_cents" is null or ("ingredient_suppliers"."pack_size" is not null and "ingredient_suppliers"."pack_unit" is not null))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"tax_id" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_org_normalized_name_key" UNIQUE("organization_id","normalized_name"),
	CONSTRAINT "suppliers_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "ingredient_price_history" ADD COLUMN "ingredient_supplier_id" text;--> statement-breakpoint
ALTER TABLE "ingredient_suppliers" ADD CONSTRAINT "ingredient_suppliers_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_suppliers" ADD CONSTRAINT "ingredient_suppliers_supplier_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."suppliers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_suppliers_org_idx" ON "ingredient_suppliers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ingredient_suppliers_org_ingredient_idx" ON "ingredient_suppliers" USING btree ("organization_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "ingredient_suppliers_org_supplier_idx" ON "ingredient_suppliers" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_suppliers_org_ingredient_default_key" ON "ingredient_suppliers" USING btree ("organization_id","ingredient_id") WHERE "ingredient_suppliers"."is_default";--> statement-breakpoint
CREATE INDEX "suppliers_org_idx" ON "suppliers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppliers_org_active_idx" ON "suppliers" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "suppliers_name_trgm_idx" ON "suppliers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ingredient_price_history_org_supplier_idx" ON "ingredient_price_history" USING btree ("organization_id","ingredient_supplier_id");