-- Sprint F1 — inventory ledger: provenance, idempotency, reversal, append-only.
-- STAGED migration (drizzle can't author the backfill): add the new columns
-- NULLABLE, backfill existing rows, only THEN flip to NOT NULL and add the
-- uniqueness/self-FK constraints, so this applies cleanly on a populated table.

-- (1) Add all new columns NULLABLE.
ALTER TABLE "inventory_movements" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "source_line_id" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reversal_of" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "idempotency_key" text;--> statement-breakpoint

-- (2) Backfill existing rows: legacy movements have no provenance, so label them
-- 'seed' and give each a unique, deterministic legacy key derived from its id.
UPDATE "inventory_movements"
  SET "source_type" = 'seed',
      "idempotency_key" = 'legacy:' || "id"
  WHERE "source_type" IS NULL;--> statement-breakpoint

-- (3) Now that every row has a value, enforce NOT NULL.
ALTER TABLE "inventory_movements" ALTER COLUMN "source_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint

-- (4) Constraints: traceability index, partial reversal unique, composite self-FK
-- (a reversal targets a real same-org movement), (org,id) self-FK target, and the
-- per-org idempotency-key unique.
CREATE INDEX "inventory_movements_org_source_idx" ON "inventory_movements" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_org_reversal_of_key" ON "inventory_movements" USING btree ("organization_id","reversal_of") WHERE "inventory_movements"."reversal_of" is not null;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_key" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_idempotency_key" UNIQUE("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_of_fk" FOREIGN KEY ("organization_id","reversal_of") REFERENCES "public"."inventory_movements"("organization_id","id") ON DELETE cascade ON UPDATE no action;
