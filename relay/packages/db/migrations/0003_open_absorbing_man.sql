CREATE TABLE "write_allowlist" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"label" text,
	"added_by" text,
	"added_at" bigint NOT NULL
);
