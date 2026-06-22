CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"dedup_key" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_org_dedup_key" UNIQUE("organization_id","dedup_key"),
	CONSTRAINT "email_outbox_status_chk" CHECK ("email_outbox"."status" in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "email_outbox_attempts_chk" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_max_attempts_chk" CHECK ("email_outbox"."max_attempts" > 0),
	CONSTRAINT "email_outbox_document_type_chk" CHECK ("email_outbox"."document_type" in ('purchase_order'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"ingredient_id" text,
	"ingredient_name" text,
	"dimension" text,
	"quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_order_items_quantity_chk" CHECK ("purchase_order_items"."quantity" > 0),
	CONSTRAINT "purchase_order_items_unit_cost_chk" CHECK ("purchase_order_items"."unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"number" integer NOT NULL,
	"currency_code" text NOT NULL,
	"supplier_id" text,
	"supplier_name" text,
	"supplier_email" text,
	"supplier_phone" text,
	"supplier_address" text,
	"supplier_tax_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" date,
	"expected_date" date,
	"notes" text,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "purchase_orders_org_number_key" UNIQUE("organization_id","number"),
	CONSTRAINT "purchase_orders_number_chk" CHECK ("purchase_orders"."number" > 0),
	CONSTRAINT "purchase_orders_status_chk" CHECK ("purchase_orders"."status" in ('draft', 'sent', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_ingredient_fk" FOREIGN KEY ("organization_id","ingredient_id") REFERENCES "public"."ingredients"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."suppliers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_org_idx" ON "email_outbox" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "email_outbox_claim_idx" ON "email_outbox" USING btree ("status","next_attempt_at") WHERE "email_outbox"."provider_message_id" is null;--> statement-breakpoint
CREATE INDEX "email_outbox_org_document_idx" ON "email_outbox" USING btree ("organization_id","document_type","document_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_org_idx" ON "purchase_order_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_po_idx" ON "purchase_order_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_org_ingredient_idx" ON "purchase_order_items" USING btree ("organization_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_idx" ON "purchase_orders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_status_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_name_trgm_idx" ON "purchase_orders" USING gin ("supplier_name" gin_trgm_ops);