ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "external_source_id" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "external_source_type" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "source_country" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "source_language" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "normalization_version" integer;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "source_payload_hash" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "quality_status" text;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "quality_warnings" jsonb;--> statement-breakpoint
ALTER TABLE "ingredient_nutrition_profiles" ADD COLUMN "salt_g" numeric(12, 4);--> statement-breakpoint
-- Open Food Facts integration plan §6.2 steps 2-3: backfill the provider-neutral
-- identity for existing USDA profiles. Additive + idempotent (guards on NULL), so
-- it is safe to re-run and safe for the currently deployed app (which ignores the
-- new columns). fdc_id is an integer; the identity is a STRING to preserve leading
-- zeroes for barcode providers, so cast on the way in.
UPDATE "ingredient_nutrition_profiles"
SET "external_source_id" = "fdc_id"::text,
    "external_source_type" = "fdc_data_type"
WHERE "source" = 'usda'
  AND "fdc_id" IS NOT NULL
  AND "external_source_id" IS NULL;