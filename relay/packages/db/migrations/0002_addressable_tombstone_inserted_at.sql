-- Add an `inserted_at` column to `deleted_addressable` tracking when the
-- tombstone was recorded (distinct from `deleted_up_to`, which is the
-- deletion event's created_at horizon). Used by the tombstone pruner so
-- backfilled kind-5 events aren't pruned immediately.
--
-- Backfill existing rows with the current wall-clock time; then drop the
-- default so future inserts must supply the value explicitly.
ALTER TABLE "deleted_addressable"
  ADD COLUMN "inserted_at" bigint NOT NULL
  DEFAULT EXTRACT(EPOCH FROM NOW())::bigint;
--> statement-breakpoint
ALTER TABLE "deleted_addressable" ALTER COLUMN "inserted_at" DROP DEFAULT;
