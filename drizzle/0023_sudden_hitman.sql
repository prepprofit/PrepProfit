CREATE TABLE "po_counters" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "po_counters_last_seq_chk" CHECK ("po_counters"."last_seq" >= 0)
);
