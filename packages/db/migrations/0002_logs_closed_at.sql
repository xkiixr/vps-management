ALTER TABLE "deployments" ADD COLUMN "logs_closed_at" timestamp with time zone;
--> statement-breakpoint
-- Every deployment that is over by now has all its log lines, as far as it ever will: no worker is writing to it.
UPDATE "deployments" SET "logs_closed_at" = coalesce("finished_at", now()) WHERE "status" IN ('SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED');
