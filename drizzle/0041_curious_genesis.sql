CREATE TABLE "ingredient_nutrition_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"source" text NOT NULL,
	"fdc_id" integer,
	"fdc_data_type" text,
	"source_description" text,
	"brand_owner" text,
	"basis_grams" numeric(12, 4) DEFAULT 100 NOT NULL,
	"calories_kcal" numeric(12, 4),
	"total_fat_g" numeric(12, 4),
	"saturated_fat_g" numeric(12, 4),
	"trans_fat_g" numeric(12, 4),
	"cholesterol_mg" numeric(12, 4),
	"sodium_mg" numeric(12, 4),
	"total_carbohydrate_g" numeric(12, 4),
	"dietary_fiber_g" numeric(12, 4),
	"total_sugars_g" numeric(12, 4),
	"added_sugars_g" numeric(12, 4),
	"protein_g" numeric(12, 4),
	"vitamin_d_mcg" numeric(12, 4),
	"calcium_mg" numeric(12, 4),
	"iron_mg" numeric(12, 4),
	"potassium_mg" numeric(12, 4),
	"caffeine_mg" numeric(12, 4),
	"source_updated_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_nutrition_profiles_org_ingredient_key" UNIQUE("organization_id","ingredient_id"),
	CONSTRAINT "ingredient_nutrition_profiles_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "ingredient_nutrition_profiles_basis_chk" CHECK ("ingredient_nutrition_profiles"."basis_grams" > 0)
);
--> statement-breakpoint
CREATE TABLE "ingredient_prep_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"name" text NOT NULL,
	"yield_bps" integer NOT NULL,
	"weight_grams" numeric(12, 4),
	"volume_ml" numeric(12, 4),
	"each_count" numeric(12, 4),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_prep_actions_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "ingredient_prep_actions_yield_bps_chk" CHECK ("ingredient_prep_actions"."yield_bps" > 0 AND "ingredient_prep_actions"."yield_bps" <= 10000),
	CONSTRAINT "ingredient_prep_actions_weight_chk" CHECK ("ingredient_prep_actions"."weight_grams" IS NULL OR "ingredient_prep_actions"."weight_grams" > 0),
	CONSTRAINT "ingredient_prep_actions_volume_chk" CHECK ("ingredient_prep_actions"."volume_ml" IS NULL OR "ingredient_prep_actions"."volume_ml" > 0),
	CONSTRAINT "ingredient_prep_actions_each_chk" CHECK ("ingredient_prep_actions"."each_count" IS NULL OR "ingredient_prep_actions"."each_count" > 0),
	CONSTRAINT "ingredient_prep_actions_sort_order_chk" CHECK ("ingredient_prep_actions"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ingredient_uom_equivalencies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"weight_grams" numeric(12, 4),
	"volume_ml" numeric(12, 4),
	"each_count" numeric(12, 4),
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_uom_equivalencies_org_ingredient_key" UNIQUE("organization_id","ingredient_id"),
	CONSTRAINT "ingredient_uom_equivalencies_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "ingredient_uom_equivalencies_weight_chk" CHECK ("ingredient_uom_equivalencies"."weight_grams" IS NULL OR "ingredient_uom_equivalencies"."weight_grams" > 0),
	CONSTRAINT "ingredient_uom_equivalencies_volume_chk" CHECK ("ingredient_uom_equivalencies"."volume_ml" IS NULL OR "ingredient_uom_equivalencies"."volume_ml" > 0),
	CONSTRAINT "ingredient_uom_equivalencies_each_chk" CHECK ("ingredient_uom_equivalencies"."each_count" IS NULL OR "ingredient_uom_equivalencies"."each_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_book_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_book_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_book_entries_org_book_recipe_key" UNIQUE("organization_id","recipe_book_id","recipe_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_books" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_books_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "recipe_books_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_books_sort_order_chk" CHECK ("recipe_books"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredient_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_ingredient_sections_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_ingredient_sections_sort_order_chk" CHECK ("recipe_ingredient_sections"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_media" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"sha256" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "recipe_media_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "recipe_media_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "recipe_method_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_method_sections_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_method_sections_sort_order_chk" CHECK ("recipe_method_sections"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_portion_options" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric(12, 4) NOT NULL,
	"unit" text NOT NULL,
	"selling_price_cents" integer,
	"target_food_cost_bps" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_nutrition_serving" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_portion_options_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_portion_options_quantity_chk" CHECK ("recipe_portion_options"."quantity" > 0),
	CONSTRAINT "recipe_portion_options_price_chk" CHECK ("recipe_portion_options"."selling_price_cents" IS NULL OR "recipe_portion_options"."selling_price_cents" >= 0),
	CONSTRAINT "recipe_portion_options_target_chk" CHECK ("recipe_portion_options"."target_food_cost_bps" IS NULL OR ("recipe_portion_options"."target_food_cost_bps" > 0 AND "recipe_portion_options"."target_food_cost_bps" <= 10000)),
	CONSTRAINT "recipe_portion_options_sort_order_chk" CHECK ("recipe_portion_options"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_step_media" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"step_id" text NOT NULL,
	"media_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"caption" text,
	CONSTRAINT "recipe_step_media_org_step_media_key" UNIQUE("organization_id","step_id","media_id"),
	CONSTRAINT "recipe_step_media_sort_order_chk" CHECK ("recipe_step_media"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"section_id" text,
	"instruction" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_steps_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_steps_sort_order_chk" CHECK ("recipe_steps"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_recipe_ingredient_key";--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "recipes_workspace_v2" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD COLUMN "section_id" text;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD COLUMN "display_sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "section_id" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "display_sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "prep_action_id" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "entered_quantity" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "entered_unit" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "subtitle" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "yield_quantity" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "yield_unit" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "nutrition_serving_quantity" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "nutrition_serving_unit" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "servings_per_container" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "cover_media_id" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD CONSTRAINT "ingredient_nutrition_profiles_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_prep_actions" ADD CONSTRAINT "ingredient_prep_actions_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_uom_equivalencies" ADD CONSTRAINT "ingredient_uom_equivalencies_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_book_entries" ADD CONSTRAINT "recipe_book_entries_book_fk" FOREIGN KEY ("organization_id","recipe_book_id") REFERENCES "public"."recipe_books"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_book_entries" ADD CONSTRAINT "recipe_book_entries_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient_sections" ADD CONSTRAINT "recipe_ingredient_sections_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_media" ADD CONSTRAINT "recipe_media_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_method_sections" ADD CONSTRAINT "recipe_method_sections_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_portion_options" ADD CONSTRAINT "recipe_portion_options_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step_media" ADD CONSTRAINT "recipe_step_media_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step_media" ADD CONSTRAINT "recipe_step_media_step_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "public"."recipe_steps"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step_media" ADD CONSTRAINT "recipe_step_media_media_fk" FOREIGN KEY ("organization_id","media_id") REFERENCES "public"."recipe_media"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_section_fk" FOREIGN KEY ("organization_id","section_id") REFERENCES "public"."recipe_method_sections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_nutrition_profiles_org_idx" ON "ingredient_nutrition_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ingredient_prep_actions_org_idx" ON "ingredient_prep_actions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ingredient_prep_actions_org_ingredient_sort_idx" ON "ingredient_prep_actions" USING btree ("organization_id","ingredient_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_prep_actions_org_ingredient_name_key" ON "ingredient_prep_actions" USING btree ("organization_id","ingredient_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ingredient_uom_equivalencies_org_idx" ON "ingredient_uom_equivalencies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_book_entries_org_idx" ON "recipe_book_entries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_book_entries_org_book_sort_idx" ON "recipe_book_entries" USING btree ("organization_id","recipe_book_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_book_entries_org_recipe_idx" ON "recipe_book_entries" USING btree ("organization_id","recipe_id");--> statement-breakpoint
CREATE INDEX "recipe_books_org_idx" ON "recipe_books" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_books_org_sort_idx" ON "recipe_books" USING btree ("organization_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_sections_org_idx" ON "recipe_ingredient_sections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_sections_org_recipe_sort_idx" ON "recipe_ingredient_sections" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_media_org_idx" ON "recipe_media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_media_org_recipe_idx" ON "recipe_media" USING btree ("organization_id","recipe_id");--> statement-breakpoint
CREATE INDEX "recipe_media_status_created_idx" ON "recipe_media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "recipe_method_sections_org_idx" ON "recipe_method_sections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_method_sections_org_recipe_sort_idx" ON "recipe_method_sections" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_portion_options_org_idx" ON "recipe_portion_options" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_portion_options_org_recipe_sort_idx" ON "recipe_portion_options" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_portion_options_one_default_key" ON "recipe_portion_options" USING btree ("organization_id","recipe_id") WHERE "recipe_portion_options"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_portion_options_one_nutrition_key" ON "recipe_portion_options" USING btree ("organization_id","recipe_id") WHERE "recipe_portion_options"."is_nutrition_serving";--> statement-breakpoint
CREATE INDEX "recipe_step_media_org_idx" ON "recipe_step_media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_step_media_org_step_sort_idx" ON "recipe_step_media" USING btree ("organization_id","step_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_steps_org_idx" ON "recipe_steps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_steps_org_recipe_sort_idx" ON "recipe_steps" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_section_fk" FOREIGN KEY ("organization_id","section_id") REFERENCES "public"."recipe_ingredient_sections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_section_fk" FOREIGN KEY ("organization_id","section_id") REFERENCES "public"."recipe_ingredient_sections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_prep_action_fk" FOREIGN KEY ("organization_id","prep_action_id") REFERENCES "public"."ingredient_prep_actions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_display_sort_order_chk" CHECK ("recipe_components"."display_sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_display_sort_order_chk" CHECK ("recipe_ingredients"."display_sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_entered_quantity_chk" CHECK ("recipe_ingredients"."entered_quantity" IS NULL OR "recipe_ingredients"."entered_quantity" >= 0);