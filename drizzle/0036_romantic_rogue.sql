CREATE TABLE "ai_operation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"feature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"quality_flags" jsonb,
	"error_code" text,
	"result_type" text,
	"result_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_operation_attempts_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_import_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"import_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"raw_text" text,
	"item_name_raw" text NOT NULL,
	"matched_ingredient_id" text,
	"quantity_value" numeric(12, 2),
	"quantity_unit" text,
	"pack_size_value" numeric(12, 2),
	"pack_size_unit" text,
	"unit_price_cents" integer,
	"line_total_cents" integer,
	"derived_price_cents" integer,
	"confidence" numeric(4, 3),
	"status" text DEFAULT 'needs_review' NOT NULL,
	"issues" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_import_lines_unit_price_chk" CHECK ("supplier_invoice_import_lines"."unit_price_cents" is null or "supplier_invoice_import_lines"."unit_price_cents" >= 0),
	CONSTRAINT "supplier_invoice_import_lines_line_total_chk" CHECK ("supplier_invoice_import_lines"."line_total_cents" is null or "supplier_invoice_import_lines"."line_total_cents" >= 0),
	CONSTRAINT "supplier_invoice_import_lines_derived_price_chk" CHECK ("supplier_invoice_import_lines"."derived_price_cents" is null or "supplier_invoice_import_lines"."derived_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"supplier_id" text,
	"supplier_name_raw" text,
	"invoice_number" text,
	"invoice_date" text,
	"currency_code" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"ai_attempt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_imports_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice_import_lines" ADD CONSTRAINT "supplier_invoice_import_lines_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "public"."supplier_invoice_imports"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_imports" ADD CONSTRAINT "supplier_invoice_imports_supplier_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."suppliers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_imports" ADD CONSTRAINT "supplier_invoice_imports_attempt_fk" FOREIGN KEY ("organization_id","ai_attempt_id") REFERENCES "public"."ai_operation_attempts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_operation_attempts_org_idx" ON "ai_operation_attempts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_operation_attempts_org_feature_created_idx" ON "ai_operation_attempts" USING btree ("organization_id","feature","created_at");--> statement-breakpoint
CREATE INDEX "supplier_invoice_import_lines_org_idx" ON "supplier_invoice_import_lines" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_import_lines_org_import_idx" ON "supplier_invoice_import_lines" USING btree ("organization_id","import_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_imports_org_idx" ON "supplier_invoice_imports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_imports_org_status_idx" ON "supplier_invoice_imports" USING btree ("organization_id","status");