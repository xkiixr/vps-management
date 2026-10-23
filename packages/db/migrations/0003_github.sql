CREATE TABLE "github_repositories" (
	"id" bigint PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"private" boolean NOT NULL,
	"installation_id" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_full_name_lower_idx" ON "github_repositories" USING btree (lower("full_name"));