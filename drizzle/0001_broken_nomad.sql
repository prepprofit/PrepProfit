ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_ingredient_id_ingredients_id_fk";
--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_org_id_key" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_org_id_key" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_ingredient_key" UNIQUE("recipe_id","ingredient_id");
