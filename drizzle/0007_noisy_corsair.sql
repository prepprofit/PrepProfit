CREATE TABLE "recipe_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_folders_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "recipe_folders_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "folder_id" text;--> statement-breakpoint
CREATE INDEX "recipe_folders_org_idx" ON "recipe_folders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recipe_folders_org_sort_idx" ON "recipe_folders" USING btree ("organization_id","sort_order");--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_folder_fk" FOREIGN KEY ("organization_id","folder_id") REFERENCES "public"."recipe_folders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipes_org_folder_idx" ON "recipes" USING btree ("organization_id","folder_id");