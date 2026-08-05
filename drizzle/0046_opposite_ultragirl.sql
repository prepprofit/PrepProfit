CREATE TABLE "vat_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_categories_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "vat_categories_name_chk" CHECK (char_length(btrim(name)) between 1 and 60),
	CONSTRAINT "vat_categories_rate_chk" CHECK (rate_bps between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "vat_category_id" text;--> statement-breakpoint
CREATE INDEX "vat_categories_org_idx" ON "vat_categories" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_categories_org_name_key" ON "vat_categories" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vat_categories_org_default_key" ON "vat_categories" USING btree ("organization_id") WHERE "vat_categories"."is_default";--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_vat_category_fk" FOREIGN KEY ("organization_id","vat_category_id") REFERENCES "public"."vat_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "vat_categories" ("id", "organization_id", "name", "rate_bps", "is_default", "sort_order")
SELECT gen_random_uuid()::text, o."organization_id", d."name",
       CASE WHEN d."is_default" THEN COALESCE(o."default_tax_rate_bps", d."rate_bps") ELSE d."rate_bps" END,
       d."is_default", d."sort_order"
FROM (
  SELECT "organization_id", "default_tax_rate_bps" FROM "organization_settings"
  UNION
  SELECT DISTINCT "organization_id", NULL::integer FROM "ingredients"
    WHERE "organization_id" NOT IN (SELECT "organization_id" FROM "organization_settings")
) o
CROSS JOIN (VALUES
  ('Food', 1400, true, 0),
  ('Alcohol', 2550, false, 1),
  ('Non-food', 2550, false, 2)
) AS d("name", "rate_bps", "is_default", "sort_order")
ON CONFLICT DO NOTHING;