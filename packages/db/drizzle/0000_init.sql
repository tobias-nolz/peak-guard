CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "intervals" (
	"start" timestamp with time zone PRIMARY KEY NOT NULL,
	"import_wh" double precision,
	"export_wh" double precision,
	"avg_import_kw" double precision,
	"avg_export_kw" double precision,
	"completeness" real NOT NULL,
	"quality" text NOT NULL,
	"source" text NOT NULL,
	"sample_count" integer NOT NULL,
	"max_import_w" real,
	"integrated_import_wh" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"grid_w" real NOT NULL,
	"load_w" real,
	"pv_w" real,
	"battery_w" real,
	"soc_pct" real,
	"import_wh" double precision,
	"export_wh" double precision
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
