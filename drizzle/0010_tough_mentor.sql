CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "ingredients_name_trgm_idx" ON "ingredients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ingredients_supplier_trgm_idx" ON "ingredients" USING gin ("supplier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recipes_name_trgm_idx" ON "recipes" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recipes_notes_trgm_idx" ON "recipes" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "transactions_note_trgm_idx" ON "transactions" USING gin ("note" gin_trgm_ops);