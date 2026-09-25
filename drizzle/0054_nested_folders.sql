ALTER TABLE "menu_folders" DROP CONSTRAINT "menu_folders_org_name_key";--> statement-breakpoint
ALTER TABLE "recipe_folders" DROP CONSTRAINT "recipe_folders_org_name_key";--> statement-breakpoint
ALTER TABLE "menu_folders" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "recipe_folders" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "menu_folders" ADD CONSTRAINT "menu_folders_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."menu_folders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_folders" ADD CONSTRAINT "recipe_folders_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."recipe_folders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_folders_org_parent_idx" ON "menu_folders" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_folders_org_root_name_key" ON "menu_folders" USING btree ("organization_id","name") WHERE "menu_folders"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_folders_org_parent_name_key" ON "menu_folders" USING btree ("organization_id","parent_id","name") WHERE "menu_folders"."parent_id" is not null;--> statement-breakpoint
CREATE INDEX "recipe_folders_org_parent_idx" ON "recipe_folders" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_folders_org_root_name_key" ON "recipe_folders" USING btree ("organization_id","name") WHERE "recipe_folders"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_folders_org_parent_name_key" ON "recipe_folders" USING btree ("organization_id","parent_id","name") WHERE "recipe_folders"."parent_id" is not null;