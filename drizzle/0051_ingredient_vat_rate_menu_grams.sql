ALTER TABLE "ingredients" ADD COLUMN "vat_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_vat_rate_chk" CHECK ("ingredients"."vat_rate_bps" IS NULL OR ("ingredients"."vat_rate_bps" >= 0 AND "ingredients"."vat_rate_bps" <= 10000));--> statement-breakpoint
-- Menu recipe components are entered in grams. Kilogram lines convert exactly.
UPDATE "menu_items" SET "quantity" = "quantity" * 1000, "unit" = 'g'
WHERE "unit" = 'kg' AND "quantity" * 1000 <= 100000000;--> statement-breakpoint
-- Recipe-portion lines convert only when the recipe has BOTH a finished batch weight
-- and a portion yield (grams = portions × batch weight ÷ portions per batch — the same
-- equivalence the cost maths uses, so line cost is unchanged). Lines without that
-- information stay as saved and the Menu editor flags them for correction.
UPDATE "menu_items" AS mi SET
  "quantity" = round(mi."quantity" * r."yield_weight_grams" / r."yield_portions", 4),
  "unit" = 'g'
FROM "recipes" AS r
WHERE mi."unit" = 'portion'
  AND r."organization_id" = mi."organization_id"
  AND r."id" = mi."recipe_id"
  AND r."yield_weight_grams" IS NOT NULL AND r."yield_weight_grams" > 0
  AND r."yield_portions" > 0
  AND round(mi."quantity" * r."yield_weight_grams" / r."yield_portions", 4) > 0
  AND round(mi."quantity" * r."yield_weight_grams" / r."yield_portions", 4) <= 100000000;
