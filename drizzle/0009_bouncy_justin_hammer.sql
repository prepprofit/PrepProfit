CREATE TABLE "transaction_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_categories_org_slug_key" UNIQUE("organization_id","slug"),
	CONSTRAINT "transaction_categories_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"category_id" text NOT NULL,
	"recipe_id" text,
	"occurred_on" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."transaction_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recipe_fk" FOREIGN KEY ("organization_id","recipe_id") REFERENCES "public"."recipes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_categories_org_idx" ON "transaction_categories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "transactions_org_idx" ON "transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "transactions_org_date_idx" ON "transactions" USING btree ("organization_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transactions_org_deleted_idx" ON "transactions" USING btree ("organization_id","deleted_at");