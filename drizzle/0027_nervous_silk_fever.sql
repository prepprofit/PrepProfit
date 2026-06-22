CREATE TABLE "receipt_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"purchase_order_item_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"ingredient_name" text NOT NULL,
	"dimension" text NOT NULL,
	"received_quantity" numeric(12, 2) NOT NULL,
	"received_unit_cost_cents" integer NOT NULL,
	"line_total_cents" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "receipt_items_quantity_chk" CHECK ("receipt_items"."received_quantity" > 0),
	CONSTRAINT "receipt_items_unit_cost_chk" CHECK ("receipt_items"."received_unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"received_date" date NOT NULL,
	"notes" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"voided_at" timestamp with time zone,
	"actor_user_id" text,
	"client_mutation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "receipts_org_id_po_key" UNIQUE("organization_id","id","purchase_order_id"),
	CONSTRAINT "receipts_org_client_mutation_key" UNIQUE("organization_id","client_mutation_id"),
	CONSTRAINT "receipts_status_chk" CHECK ("receipts"."status" in ('posted', 'voided'))
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_status_chk";--> statement-breakpoint
ALTER TABLE "purchase_order_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 2);--> statement-breakpoint
ALTER TABLE "purchase_order_items" ALTER COLUMN "quantity" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ingredient_price_history" ADD COLUMN "source_receipt_item_id" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_org_po_id_key" UNIQUE("organization_id","purchase_order_id","id");--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_fk" FOREIGN KEY ("organization_id","receipt_id") REFERENCES "public"."receipts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_po_fk" FOREIGN KEY ("organization_id","receipt_id","purchase_order_id") REFERENCES "public"."receipts"("organization_id","id","purchase_order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_po_item_fk" FOREIGN KEY ("organization_id","purchase_order_id","purchase_order_item_id") REFERENCES "public"."purchase_order_items"("organization_id","purchase_order_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_po_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_items_org_idx" ON "receipt_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "receipt_items_org_receipt_idx" ON "receipt_items" USING btree ("organization_id","receipt_id");--> statement-breakpoint
CREATE INDEX "receipt_items_org_po_item_idx" ON "receipt_items" USING btree ("organization_id","purchase_order_item_id");--> statement-breakpoint
CREATE INDEX "receipt_items_org_ingredient_idx" ON "receipt_items" USING btree ("organization_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "receipts_org_idx" ON "receipts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "receipts_org_po_idx" ON "receipts" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "ingredient_price_history_org_receipt_item_idx" ON "ingredient_price_history" USING btree ("organization_id","source_receipt_item_id");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_status_chk" CHECK ("purchase_orders"."status" in ('draft', 'sent', 'partially_received', 'received', 'cancelled'));