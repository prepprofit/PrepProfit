CREATE TABLE "inventory_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"delta_canonical" numeric(12, 2) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "stock_quantity" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "low_stock_threshold" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_org_idx" ON "inventory_movements" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_org_ingredient_idx" ON "inventory_movements" USING btree ("organization_id","ingredient_id");