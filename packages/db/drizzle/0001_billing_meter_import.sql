CREATE TABLE "billing_intervals" (
	"start" timestamp with time zone PRIMARY KEY NOT NULL,
	"import_wh" double precision NOT NULL,
	"status" text,
	"batch_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"row_count" integer NOT NULL,
	"from" timestamp with time zone NOT NULL,
	"to" timestamp with time zone NOT NULL,
	"alignment" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_intervals" ADD CONSTRAINT "billing_intervals_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;