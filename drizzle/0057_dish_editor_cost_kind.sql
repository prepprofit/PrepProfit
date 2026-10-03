ALTER TABLE "ingredients" ADD COLUMN "cost_kind" text;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "output_label" text;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "display_unit" text DEFAULT 'g' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_cost_kind_chk" CHECK ("ingredients"."cost_kind" is null or "ingredients"."cost_kind" in ('food', 'packaging'));--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_output_label_chk" CHECK ("menus"."output_label" is null or char_length("menus"."output_label") between 1 and 40);--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_display_unit_chk" CHECK ("menus"."display_unit" in ('g', 'kg'));