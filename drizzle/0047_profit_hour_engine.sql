CREATE TABLE "profit_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"rent_cents" integer DEFAULT 0 NOT NULL,
	"equipment_leases_cents" integer DEFAULT 0 NOT NULL,
	"equipment_depreciation_cents" integer DEFAULT 0 NOT NULL,
	"insurance_licenses_cents" integer DEFAULT 0 NOT NULL,
	"utilities_cents" integer DEFAULT 0 NOT NULL,
	"salaried_staff_cents" integer DEFAULT 0 NOT NULL,
	"software_cents" integer DEFAULT 0 NOT NULL,
	"productive_hours_per_month" integer,
	"owner_target_income_per_hour_cents" integer DEFAULT 0 NOT NULL,
	"sublet_enabled" boolean DEFAULT false NOT NULL,
	"sublet_ingredient_multiplier_bps" integer DEFAULT 14000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_settings_costs_chk" CHECK ("profit_settings"."rent_cents" >= 0 AND "profit_settings"."equipment_leases_cents" >= 0 AND "profit_settings"."equipment_depreciation_cents" >= 0 AND "profit_settings"."insurance_licenses_cents" >= 0 AND "profit_settings"."utilities_cents" >= 0 AND "profit_settings"."salaried_staff_cents" >= 0 AND "profit_settings"."software_cents" >= 0 AND "profit_settings"."owner_target_income_per_hour_cents" >= 0),
	CONSTRAINT "profit_settings_hours_chk" CHECK ("profit_settings"."productive_hours_per_month" IS NULL OR ("profit_settings"."productive_hours_per_month" >= 1 AND "profit_settings"."productive_hours_per_month" <= 744)),
	CONSTRAINT "profit_settings_multiplier_chk" CHECK ("profit_settings"."sublet_ingredient_multiplier_bps" >= 10000 AND "profit_settings"."sublet_ingredient_multiplier_bps" <= 30000)
);
--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "batch_time_minutes" integer;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "sale_unit" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "waste_bps" integer;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "delivery_per_unit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "extra_step_minutes" integer;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "extra_step_price_cents" integer;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_profit_inputs_chk" CHECK (("recipes"."batch_time_minutes" IS NULL OR "recipes"."batch_time_minutes" > 0) AND ("recipes"."waste_bps" IS NULL OR ("recipes"."waste_bps" >= 0 AND "recipes"."waste_bps" <= 9000)) AND "recipes"."delivery_per_unit_cents" >= 0 AND ("recipes"."extra_step_minutes" IS NULL OR "recipes"."extra_step_minutes" > 0) AND ("recipes"."extra_step_price_cents" IS NULL OR "recipes"."extra_step_price_cents" >= 0));