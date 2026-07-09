CREATE TABLE "recipe_components" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"component_recipe_id" text NOT NULL,
	"quantity_grams" numeric(10, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "recipe_components_org_parent_component_key" UNIQUE("organization_id","recipe_id","component_recipe_id"),
	CONSTRAINT "recipe_components_not_self_chk" CHECK ("recipe_components"."recipe_id" <> "recipe_components"."component_recipe_id"),
	CONSTRAINT "recipe_components_quantity_chk" CHECK ("recipe_components"."quantity_grams" > 0),
	CONSTRAINT "recipe_components_sort_order_chk" CHECK ("recipe_components"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_parent_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_component_fk" FOREIGN KEY ("organization_id","component_recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_components_org_idx" ON "recipe_components" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_components_org_recipe_sort_idx" ON "recipe_components" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_components_org_component_idx" ON "recipe_components" USING btree ("organization_id","component_recipe_id");