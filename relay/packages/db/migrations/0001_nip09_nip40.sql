CREATE TABLE "deleted_addressable" (
	"pubkey" text NOT NULL,
	"kind" integer NOT NULL,
	"d_tag" text NOT NULL,
	"deleted_up_to" bigint NOT NULL,
	"deleted_by_event" text NOT NULL,
	CONSTRAINT "deleted_addressable_pubkey_kind_d_tag_pk" PRIMARY KEY("pubkey","kind","d_tag")
);
--> statement-breakpoint
CREATE TABLE "deleted_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"pubkey" text NOT NULL,
	"deleted_at" bigint NOT NULL,
	"deleted_by_event" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "expires_at" bigint;--> statement-breakpoint
CREATE INDEX "deleted_events_pubkey_idx" ON "deleted_events" USING btree ("pubkey");--> statement-breakpoint
CREATE INDEX "events_expires_at_idx" ON "events" USING btree ("expires_at") WHERE "events"."expires_at" IS NOT NULL;