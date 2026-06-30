CREATE TABLE "recipe_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"name" text NOT NULL,
	"target_weight_grams" numeric(10, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_presets_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "recipe_presets_target_weight_chk" CHECK ("recipe_presets"."target_weight_grams" > 0),
	CONSTRAINT "recipe_presets_sort_order_chk" CHECK ("recipe_presets"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recipe_presets" ADD CONSTRAINT "recipe_presets_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_presets_org_idx" ON "recipe_presets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_presets_org_recipe_sort_idx" ON "recipe_presets" USING btree ("organization_id","recipe_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_presets_org_recipe_name_key" ON "recipe_presets" USING btree ("organization_id","recipe_id",lower("name"));