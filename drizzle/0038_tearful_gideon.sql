ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_document_type_chk";--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "weekly_cfo_report_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_document_type_chk" CHECK ("email_outbox"."document_type" in ('purchase_order', 'cfo_report'));