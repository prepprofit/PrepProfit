ALTER TABLE "organization_settings" ADD COLUMN "default_tax_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "stock_control_start_date" date;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_org_source_key" ON "transactions" USING btree ("organization_id","source_type","source_id") WHERE "transactions"."source_type" is not null;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_pair_chk" CHECK (("transactions"."source_type" is null) = ("transactions"."source_id" is null));