ALTER TABLE "recipe_ingredients" RENAME COLUMN "quantity_grams" TO "quantity";--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "dimension" text DEFAULT 'weight' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" DROP COLUMN "unit";--> statement-breakpoint
ALTER TABLE "ingredients" DROP COLUMN "price_type";
