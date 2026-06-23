CREATE TABLE "task_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"scheduled_for" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "task_lists_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "task_lists_name_chk" CHECK (char_length(btrim("task_lists"."name")) between 1 and 200),
	CONSTRAINT "task_lists_notes_chk" CHECK ("task_lists"."notes" is null or char_length("task_lists"."notes") <= 1000),
	CONSTRAINT "task_lists_sort_order_chk" CHECK ("task_lists"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_list_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"station" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_user_id" text,
	"due_on" date,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"source_recipe_id" text,
	"source_ingredient_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_chk" CHECK (char_length(btrim("tasks"."title")) between 1 and 200),
	CONSTRAINT "tasks_notes_chk" CHECK ("tasks"."notes" is null or char_length("tasks"."notes") <= 1000),
	CONSTRAINT "tasks_station_chk" CHECK ("tasks"."station" is null or char_length("tasks"."station") <= 60),
	CONSTRAINT "tasks_status_chk" CHECK (status IN ('open', 'done')),
	CONSTRAINT "tasks_sort_order_chk" CHECK ("tasks"."sort_order" >= 0),
	CONSTRAINT "tasks_completed_at_chk" CHECK (("tasks"."completed_at" is not null) = ("tasks"."status" = 'done')),
	CONSTRAINT "tasks_completed_by_chk" CHECK (("tasks"."completed_by" is not null) = ("tasks"."status" = 'done')),
	CONSTRAINT "tasks_source_kind_chk" CHECK (source_kind IN ('manual', 'prep', 'reorder')),
	CONSTRAINT "tasks_source_shape_chk" CHECK ((
        ("tasks"."source_kind" = 'manual' and "tasks"."source_recipe_id" is null and "tasks"."source_ingredient_id" is null)
        or ("tasks"."source_kind" = 'prep' and "tasks"."source_recipe_id" is not null and "tasks"."source_ingredient_id" is null)
        or ("tasks"."source_kind" = 'reorder' and "tasks"."source_recipe_id" is null and "tasks"."source_ingredient_id" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_task_list_fk" FOREIGN KEY ("organization_id","task_list_id") REFERENCES "public"."task_lists"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_recipe_fk" FOREIGN KEY ("organization_id","source_recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_ingredient_fk" FOREIGN KEY ("organization_id","source_ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_lists_org_idx" ON "task_lists" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "task_lists_org_deleted_idx" ON "task_lists" USING btree ("organization_id","deleted_at");--> statement-breakpoint
CREATE INDEX "task_lists_org_scheduled_idx" ON "task_lists" USING btree ("organization_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "task_lists_name_trgm_idx" ON "task_lists" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_org_task_list_idx" ON "tasks" USING btree ("organization_id","task_list_id");--> statement-breakpoint
CREATE INDEX "tasks_org_assignee_idx" ON "tasks" USING btree ("organization_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "tasks_org_source_recipe_idx" ON "tasks" USING btree ("organization_id","source_recipe_id");--> statement-breakpoint
CREATE INDEX "tasks_org_source_ingredient_idx" ON "tasks" USING btree ("organization_id","source_ingredient_id");