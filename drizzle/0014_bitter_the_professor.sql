CREATE TABLE "subscriptions" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"status" text NOT NULL,
	"clerk_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"last_event_type" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
