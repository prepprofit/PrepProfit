CREATE TABLE "ingredient_price_history" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"source" text NOT NULL,
	"pack_size" numeric(12, 2),
	"pack_unit" text,
	"pack_price_cents" integer,
	"derived_price_cents" integer NOT NULL,
	"accepted" boolean DEFAULT false NOT NULL,
	"actor_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "pending_price_cents" integer;--> statement-breakpoint
ALTER TABLE "ingredient_price_history" ADD CONSTRAINT "ingredient_price_history_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_price_history_org_idx" ON "ingredient_price_history" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ingredient_price_history_org_ingredient_idx" ON "ingredient_price_history" USING btree ("organization_id","ingredient_id","created_at");