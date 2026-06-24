CREATE TABLE "event_tags" (
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"value" text,
	"rest" text[],
	CONSTRAINT "event_tags_event_id_position_pk" PRIMARY KEY("event_id","position")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"pubkey" text NOT NULL,
	"created_at" bigint NOT NULL,
	"kind" integer NOT NULL,
	"content" text NOT NULL,
	"sig" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_tags" ADD CONSTRAINT "event_tags_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_tags_name_value_idx" ON "event_tags" USING btree ("name","value","event_id") WHERE "event_tags"."name" ~ '^[a-zA-Z]$';--> statement-breakpoint
CREATE INDEX "events_pubkey_created_at_idx" ON "events" USING btree ("pubkey","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_kind_created_at_idx" ON "events" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "events" USING btree ("created_at" DESC NULLS LAST);