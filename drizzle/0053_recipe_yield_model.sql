ALTER TABLE "recipes" ADD COLUMN "yield_weight_source" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "yield_review_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A finished weight typed before this release was measured by the chef.
UPDATE "recipes" SET "yield_weight_source" = 'measured'
WHERE "yield_weight_grams" IS NOT NULL AND "yield_weight_source" IS NULL;--> statement-breakpoint
-- Yield % used to inflate ingredient cost; it now reduces the finished weight
-- instead (loss applied once). Flag those recipes so the chef confirms the yield.
UPDATE "recipes" SET "yield_review_needed" = true
WHERE "yield_percentage" <> 100 AND "deleted_at" IS NULL;--> statement-breakpoint
-- Finished weight where it can be calculated honestly: every direct line is a
-- weight line (grams) — ml and pieces are never counted as grams — plus sub-recipe
-- grams, times the yield. Recipes with volume/count lines stay without a weight
-- and the editor asks for a measured one.
WITH inputs AS (
  SELECT
    r."organization_id",
    r."id",
    COALESCE((
      SELECT SUM(ri."quantity"::numeric)
      FROM "recipe_ingredients" ri
      JOIN "ingredients" i ON i."organization_id" = ri."organization_id" AND i."id" = ri."ingredient_id"
      WHERE ri."organization_id" = r."organization_id" AND ri."recipe_id" = r."id" AND i."dimension" = 'weight'
    ), 0) AS weight_grams,
    (
      SELECT COUNT(*)
      FROM "recipe_ingredients" ri
      JOIN "ingredients" i ON i."organization_id" = ri."organization_id" AND i."id" = ri."ingredient_id"
      WHERE ri."organization_id" = r."organization_id" AND ri."recipe_id" = r."id" AND i."dimension" <> 'weight'
    ) AS other_lines,
    COALESCE((
      SELECT SUM(rc."quantity_grams"::numeric)
      FROM "recipe_components" rc
      WHERE rc."organization_id" = r."organization_id" AND rc."recipe_id" = r."id"
    ), 0) AS component_grams
  FROM "recipes" r
  WHERE r."yield_weight_grams" IS NULL AND r."yield_percentage" > 0
)
UPDATE "recipes" AS r SET
  "yield_weight_grams" = round((inputs.weight_grams + inputs.component_grams) * r."yield_percentage" / 100, 2),
  "yield_weight_source" = 'calculated'
FROM inputs
WHERE r."organization_id" = inputs."organization_id"
  AND r."id" = inputs."id"
  AND inputs.other_lines = 0
  AND round((inputs.weight_grams + inputs.component_grams) * r."yield_percentage" / 100, 2) > 0
  AND round((inputs.weight_grams + inputs.component_grams) * r."yield_percentage" / 100, 2) <= 99999999.99;
