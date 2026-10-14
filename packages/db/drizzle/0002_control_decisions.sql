CREATE TABLE "control_decisions" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"controller_mode" text NOT NULL,
	"decision" text NOT NULL,
	"target_kw" real NOT NULL,
	"required_w" real NOT NULL,
	"limit_w" real,
	"projected_kw" real NOT NULL,
	"grid_w" real NOT NULL,
	"battery_w" real,
	"soc_pct" real,
	"stor_ctl_mod" smallint,
	"out_w_rte_pct" real,
	"applied" boolean NOT NULL,
	"note" text
);
