CREATE TABLE "ingredient_allergens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"allergen" text NOT NULL,
	"presence" text NOT NULL,
	CONSTRAINT "ingredient_allergens_org_ingredient_allergen_key" UNIQUE("organization_id","ingredient_id","allergen"),
	CONSTRAINT "ingredient_allergens_allergen_chk" CHECK (allergen IN ('cereals_gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs')),
	CONSTRAINT "ingredient_allergens_presence_chk" CHECK (presence IN ('may_contain', 'contains'))
);
--> statement-breakpoint
CREATE TABLE "recipe_allergen_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"allergen" text NOT NULL,
	"presence" text NOT NULL,
	CONSTRAINT "recipe_allergen_overrides_org_recipe_allergen_key" UNIQUE("organization_id","recipe_id","allergen"),
	CONSTRAINT "recipe_allergen_overrides_allergen_chk" CHECK (allergen IN ('cereals_gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs')),
	CONSTRAINT "recipe_allergen_overrides_presence_chk" CHECK (presence IN ('may_contain', 'contains'))
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "allergens_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "allergens_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "ingredient_allergens" ADD CONSTRAINT "ingredient_allergens_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_allergen_overrides" ADD CONSTRAINT "recipe_allergen_overrides_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_allergens_org_idx" ON "ingredient_allergens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ingredient_allergens_org_ingredient_idx" ON "ingredient_allergens" USING btree ("organization_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_allergen_overrides_org_idx" ON "recipe_allergen_overrides" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_allergen_overrides_org_recipe_idx" ON "recipe_allergen_overrides" USING btree ("organization_id","recipe_id");