CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"measurement_system" text DEFAULT 'metric' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
