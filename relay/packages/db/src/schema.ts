import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    pubkey: text("pubkey").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    kind: integer("kind").notNull(),
    content: text("content").notNull(),
    sig: text("sig").notNull(),
    /** NIP-40 expiration timestamp (unix seconds). Null = no expiration. */
    expiresAt: bigint("expires_at", { mode: "number" }),
  },
  (t) => [
    index("events_pubkey_created_at_idx").on(t.pubkey, t.createdAt.desc()),
    index("events_kind_created_at_idx").on(t.kind, t.createdAt.desc()),
    index("events_created_at_idx").on(t.createdAt.desc()),
    index("events_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

export const eventTags = pgTable(
  "event_tags",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    value: text("value"),
    rest: text("rest").array(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.position] }),
    index("event_tags_name_value_idx")
      .on(t.name, t.value, t.eventId)
      .where(sql`${t.name} ~ '^[a-zA-Z]$'`),
  ],
);

/**
 * NIP-09 tombstones for deleted regular events.
 * When a kind-5 deletion request is processed and the targeted event id is
 * owned by the same pubkey, we remove the event and record a tombstone here
 * so the same id cannot be re-published.
 */
export const deletedEvents = pgTable(
  "deleted_events",
  {
    eventId: text("event_id").primaryKey(),
    pubkey: text("pubkey").notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull(),
    deletedByEvent: text("deleted_by_event").notNull(),
  },
  (t) => [index("deleted_events_pubkey_idx").on(t.pubkey)],
);

/**
 * NIP-09 tombstones for deleted addressable events (kind 30000-39999).
 * An `a` tag deletion applies to "all versions up to created_at"; we record
 * the high-water mark so replays or re-publishes with a created_at ≤ this
 * value are rejected. Newer versions (created_at > deletedUpTo) are allowed.
 */
export const deletedAddressable = pgTable(
  "deleted_addressable",
  {
    pubkey: text("pubkey").notNull(),
    kind: integer("kind").notNull(),
    dTag: text("d_tag").notNull(),
    /** Horizon: events with created_at ≤ this value are blocked from re-publish. */
    deletedUpTo: bigint("deleted_up_to", { mode: "number" }).notNull(),
    /**
     * Wall-clock time the tombstone was recorded/refreshed. Used by the
     * tombstone pruner so backfilled deletions (old kind-5 created_at, recent
     * arrival) aren't pruned immediately.
     */
    insertedAt: bigint("inserted_at", { mode: "number" }).notNull(),
    deletedByEvent: text("deleted_by_event").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pubkey, t.kind, t.dTag] })],
);

/**
 * Write allowlist for "team write" relays. When this table is non-empty, only
 * events whose author `pubkey` appears here are accepted for writing; reads
 * stay open. An empty table means open writes (no gate). This is the live,
 * DB-backed source the relay watches (LISTEN/NOTIFY + poll); the admin UI
 * manages it. `WRITE_ALLOWLIST_PUBKEYS` seeds this table on first boot for
 * backward compatibility, after which the table is authoritative.
 */
export const writeAllowlist = pgTable("write_allowlist", {
  /** 64-char lowercase hex pubkey. */
  pubkey: text("pubkey").primaryKey(),
  /** Optional human-readable note (e.g. whose key this is). */
  label: text("label"),
  /** Pubkey of the admin (NIP-07 login) who added the entry, for audit. */
  addedBy: text("added_by"),
  /** Wall-clock unix seconds the entry was added. */
  addedAt: bigint("added_at", { mode: "number" }).notNull(),
});

/**
 * Operators allowed to sign into the admin UI (apps/admin). NOT read by the
 * relay — it lives here only because the admin UI shares this database and the
 * relay's migrator is the single place migrations run. Seeded once from
 * `ADMIN_PUBKEYS` when empty; thereafter managed in the admin UI.
 */
export const admins = pgTable("admins", {
  /** 64-char lowercase hex pubkey. */
  pubkey: text("pubkey").primaryKey(),
  /** Optional human-readable note. */
  label: text("label"),
  /** Pubkey of the admin who added this one (null for env-seeded entries). */
  addedBy: text("added_by"),
  /** Wall-clock unix seconds the entry was added. */
  addedAt: bigint("added_at", { mode: "number" }).notNull(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventTag = typeof eventTags.$inferSelect;
export type NewEventTag = typeof eventTags.$inferInsert;
export type DeletedEvent = typeof deletedEvents.$inferSelect;
export type DeletedAddressable = typeof deletedAddressable.$inferSelect;
export type WriteAllowlistEntry = typeof writeAllowlist.$inferSelect;
export type NewWriteAllowlistEntry = typeof writeAllowlist.$inferInsert;
export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
