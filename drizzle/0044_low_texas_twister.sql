CREATE TABLE "external_food_cache" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"normalization_version" integer NOT NULL,
	"payload_hash" text,
	CONSTRAINT "external_food_cache_provider_external_id_key" UNIQUE("provider","external_id")
);
