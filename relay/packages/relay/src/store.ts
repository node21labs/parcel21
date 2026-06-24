import { deletedAddressable, deletedEvents, eventTags, events, type DB } from "@relay/db";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { type Filter } from "./domain/filter.ts";
import { KIND_DELETION, parseDeletionRequest, type AddressableTarget } from "./domain/deletion.ts";
import { parseExpiration } from "./domain/expiration.ts";
import { classifyKind, dTagValue } from "./domain/kinds.ts";
import type { NostrEvent } from "./domain/validate.ts";
import { nullLogger, type Logger } from "./logger.ts";
import { nullMetrics, type Metrics } from "./metrics.ts";

export type SaveOutcome =
  | { type: "stored" }
  | { type: "duplicate" }
  | { type: "replaced"; removed: number }
  | { type: "outdated" }
  | { type: "ephemeral" }
  | { type: "blocked"; reason: string }
  | { type: "expired" }
  | { type: "invalid"; reason: string };

export interface EventStoreOptions {
  /** Default per-filter limit when a filter has no `limit` property. */
  defaultLimit?: number;
  /** Clock returning the current time in unix seconds. Overridable for tests. */
  now?: () => number;
  /** Structured logger. Defaults to `nullLogger`. */
  logger?: Logger;
  /** Metrics sink. Defaults to `nullMetrics`. */
  metrics?: Metrics;
}

const SINGLE_LETTER = /^[a-zA-Z]$/;

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export class EventStore {
  private readonly defaultLimit: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(
    private readonly db: DB,
    options: EventStoreOptions = {},
  ) {
    this.defaultLimit = options.defaultLimit ?? 500;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.logger = (options.logger ?? nullLogger).child({ component: "store" });
    this.metrics = options.metrics ?? nullMetrics;
  }

  async save(event: NostrEvent): Promise<SaveOutcome> {
    const start = Date.now();
    const outcome = await this.saveInner(event);
    const durationMs = Date.now() - start;
    this.metrics.timing("event_save_duration_ms", durationMs);
    this.metrics.increment(`events_${outcome.type}`);
    this.logger.debug(
      { eventId: event.id, kind: event.kind, outcome: outcome.type, durationMs },
      "save",
    );
    return outcome;
  }

  private async saveInner(event: NostrEvent): Promise<SaveOutcome> {
    const kindClass = classifyKind(event.kind);
    if (kindClass === "ephemeral") return { type: "ephemeral" };

    // NIP-40: reject malformed / already-expired events before touching the DB.
    const exp = parseExpiration(event);
    if (exp.kind === "invalid") {
      return { type: "invalid", reason: "malformed expiration tag" };
    }
    const expiresAt = exp.kind === "ok" ? exp.expiresAt : null;
    if (expiresAt !== null && expiresAt <= this.now()) {
      return { type: "expired" };
    }

    return await this.db.transaction(async (tx) => {
      // NIP-09: reject re-publishes of previously-deleted events. We match
      // both the id AND the pubkey: the tombstone's pubkey is the kind-5
      // author, so a late arrival is only blocked when its author claims the
      // same identity the kind-5 claimed. An attacker who blanket-targets
      // other authors' ids can't block their publishes.
      const tombstone = await tx
        .select({ id: deletedEvents.eventId })
        .from(deletedEvents)
        .where(and(eq(deletedEvents.eventId, event.id), eq(deletedEvents.pubkey, event.pubkey)))
        .limit(1);
      if (tombstone.length > 0) {
        return { type: "blocked", reason: "user requested deletion" };
      }

      // NIP-09: reject re-publishes of deleted addressable coordinates.
      if (kindClass === "addressable" || kindClass === "replaceable") {
        const d = kindClass === "addressable" ? dTagValue(event.tags) : "";
        const coord = await tx
          .select({ deletedUpTo: deletedAddressable.deletedUpTo })
          .from(deletedAddressable)
          .where(
            and(
              eq(deletedAddressable.pubkey, event.pubkey),
              eq(deletedAddressable.kind, event.kind),
              eq(deletedAddressable.dTag, d),
            ),
          )
          .limit(1);
        if (coord.length > 0 && event.created_at <= coord[0]!.deletedUpTo) {
          return { type: "blocked", reason: "user requested deletion" };
        }
      }

      if (event.kind === KIND_DELETION) {
        return saveDeletionRequest(tx, event, expiresAt, this.now());
      }
      if (kindClass === "replaceable") return saveReplaceable(tx, event, expiresAt);
      if (kindClass === "addressable") return saveAddressable(tx, event, expiresAt);
      return saveRegular(tx, event, expiresAt);
    });
  }

  async *query(filters: Filter[]): AsyncIterable<NostrEvent> {
    if (filters.length === 0) return;

    const start = Date.now();
    const now = this.now();
    const seen = new Set<string>();
    const collected: NostrEvent[] = [];

    for (const filter of filters) {
      const rows = await this.queryOne(filter, now);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        collected.push(row);
      }
    }

    const durationMs = Date.now() - start;
    this.metrics.timing("query_duration_ms", durationMs);
    this.metrics.increment("queries");
    this.logger.debug(
      {
        filterCount: filters.length,
        resultCount: collected.length,
        durationMs,
      },
      "query",
    );

    collected.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (const e of collected) yield e;
  }

  /**
   * NIP-40: remove events whose `expires_at` is in the past. Query-time
   * filtering already hides them; this call keeps the on-disk footprint
   * bounded. Safe to call repeatedly; idempotent.
   */
  async sweepExpired(): Promise<{ removed: number }> {
    const now = this.now();
    const deleted = await this.db
      .delete(events)
      .where(and(isNotNull(events.expiresAt), lte(events.expiresAt, now)))
      .returning({ id: events.id });
    const removed = deleted.length;
    this.metrics.increment("sweep_expired_removed", removed);
    if (removed > 0) {
      this.logger.info({ removed, now }, "sweep expired");
    }
    return { removed };
  }

  /**
   * NIP-09: prune tombstones older than `olderThanSeconds` seconds. Tombstones
   * prevent re-publish of deleted events; after a stale tombstone is pruned,
   * a future re-publish would be allowed. Operators opt in per their policy.
   *
   * Age is measured by **when the tombstone was recorded** (wall-clock at
   * save time), not by the kind-5's `created_at`. Backfilled/replayed
   * deletions with old `created_at` but recent arrival are therefore NOT
   * pruned immediately.
   */
  async pruneTombstones(olderThanSeconds: number): Promise<{
    events: number;
    addressables: number;
  }> {
    const cutoff = this.now() - olderThanSeconds;

    const removedEvents = await this.db
      .delete(deletedEvents)
      .where(lte(deletedEvents.deletedAt, cutoff))
      .returning({ id: deletedEvents.eventId });

    const removedAddrs = await this.db
      .delete(deletedAddressable)
      .where(lte(deletedAddressable.insertedAt, cutoff))
      .returning({ pubkey: deletedAddressable.pubkey });

    const result = {
      events: removedEvents.length,
      addressables: removedAddrs.length,
    };
    this.metrics.increment("sweep_tombstone_events_removed", result.events);
    this.metrics.increment("sweep_tombstone_addressables_removed", result.addressables);
    if (result.events + result.addressables > 0) {
      this.logger.info({ ...result, olderThanSeconds }, "prune tombstones");
    }
    return result;
  }

  private async queryOne(filter: Filter, now: number): Promise<NostrEvent[]> {
    const conds: SQL[] = [];

    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return [];
      conds.push(inArray(events.id, filter.ids));
    }
    if (filter.authors !== undefined) {
      if (filter.authors.length === 0) return [];
      conds.push(inArray(events.pubkey, filter.authors));
    }
    if (filter.kinds !== undefined) {
      if (filter.kinds.length === 0) return [];
      conds.push(inArray(events.kind, filter.kinds));
    }
    if (filter.since !== undefined) conds.push(gte(events.createdAt, filter.since));
    if (filter.until !== undefined) conds.push(lte(events.createdAt, filter.until));

    for (const [key, value] of Object.entries(filter)) {
      if (key.length !== 2 || key[0] !== "#") continue;
      const letter = key[1]!;
      if (!SINGLE_LETTER.test(letter)) continue;
      if (!Array.isArray(value)) continue;
      if (value.length === 0) return [];
      conds.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(eventTags)
            .where(
              and(
                eq(eventTags.eventId, events.id),
                eq(eventTags.name, letter),
                inArray(eventTags.value, value as string[]),
              ),
            ),
        ),
      );
    }

    // NIP-40: skip events that have already expired.
    const notExpired = or(isNull(events.expiresAt), gt(events.expiresAt, now)) as SQL;
    conds.push(notExpired);

    const limit = Math.min(filter.limit ?? this.defaultLimit, this.defaultLimit);

    const rows = await this.db
      .select()
      .from(events)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(events.createdAt), asc(events.id))
      .limit(limit);

    return Promise.all(rows.map((row) => hydrate(this.db, row)));
  }
}

async function hydrate(db: DB, row: typeof events.$inferSelect): Promise<NostrEvent> {
  const tagRows = await db
    .select()
    .from(eventTags)
    .where(eq(eventTags.eventId, row.id))
    .orderBy(asc(eventTags.position));

  const tags: string[][] = tagRows.map((t) => {
    const tag = [t.name];
    if (t.value !== null) tag.push(t.value);
    if (t.rest && t.rest.length > 0) tag.push(...t.rest);
    return tag;
  });

  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.createdAt,
    kind: row.kind,
    tags,
    content: row.content,
    sig: row.sig,
  };
}

function eventRow(event: NostrEvent, expiresAt: number | null) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    content: event.content,
    sig: event.sig,
    expiresAt,
  };
}

function tagRows(event: NostrEvent) {
  return event.tags.map((tag, position) => ({
    eventId: event.id,
    position,
    name: tag[0] ?? "",
    value: tag[1] ?? null,
    rest: tag.length > 2 ? tag.slice(2) : null,
  }));
}

async function insertEventWithTags(
  tx: Tx,
  event: NostrEvent,
  expiresAt: number | null,
): Promise<void> {
  await tx.insert(events).values(eventRow(event, expiresAt));
  if (event.tags.length > 0) await tx.insert(eventTags).values(tagRows(event));
}

async function saveRegular(
  tx: Tx,
  event: NostrEvent,
  expiresAt: number | null,
): Promise<SaveOutcome> {
  const inserted = await tx
    .insert(events)
    .values(eventRow(event, expiresAt))
    .onConflictDoNothing()
    .returning({ id: events.id });

  if (inserted.length === 0) return { type: "duplicate" };

  if (event.tags.length > 0) {
    await tx.insert(eventTags).values(tagRows(event));
  }

  return { type: "stored" };
}

async function saveReplaceable(
  tx: Tx,
  event: NostrEvent,
  expiresAt: number | null,
): Promise<SaveOutcome> {
  const existing = await tx
    .select({
      id: events.id,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.pubkey, event.pubkey), eq(events.kind, event.kind)));

  const losers = existing.filter((e) => losesTo(e, event));
  const survivors = existing.filter((e) => !losesTo(e, event));

  if (losers.length > 0) {
    await tx.delete(events).where(
      inArray(
        events.id,
        losers.map((e) => e.id),
      ),
    );
  }

  if (survivors.length > 0) {
    return { type: "outdated" };
  }

  await insertEventWithTags(tx, event, expiresAt);
  if (losers.length > 0) return { type: "replaced", removed: losers.length };
  return { type: "stored" };
}

async function saveAddressable(
  tx: Tx,
  event: NostrEvent,
  expiresAt: number | null,
): Promise<SaveOutcome> {
  const incomingD = dTagValue(event.tags);

  const existing = await tx
    .select({
      id: events.id,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.pubkey, event.pubkey), eq(events.kind, event.kind)));

  if (existing.length === 0) {
    await insertEventWithTags(tx, event, expiresAt);
    return { type: "stored" };
  }

  const existingWithD = await Promise.all(
    existing.map(async (e) => {
      const rows = await tx
        .select({ value: eventTags.value })
        .from(eventTags)
        .where(and(eq(eventTags.eventId, e.id), eq(eventTags.name, "d")))
        .orderBy(asc(eventTags.position))
        .limit(1);
      return { ...e, d: rows[0]?.value ?? "" };
    }),
  );

  const matching = existingWithD.filter((e) => e.d === incomingD);
  const losers = matching.filter((e) => losesTo(e, event));
  const survivors = matching.filter((e) => !losesTo(e, event));

  if (losers.length > 0) {
    await tx.delete(events).where(
      inArray(
        events.id,
        losers.map((e) => e.id),
      ),
    );
  }

  if (survivors.length > 0) return { type: "outdated" };

  await insertEventWithTags(tx, event, expiresAt);
  if (losers.length > 0) return { type: "replaced", removed: losers.length };
  return { type: "stored" };
}

/**
 * NIP-09: store the kind-5 deletion request itself (so relays can replicate
 * it) and apply its `e`/`a` tags — deleting any matching events owned by the
 * same pubkey and recording tombstones.
 */
async function saveDeletionRequest(
  tx: Tx,
  event: NostrEvent,
  expiresAt: number | null,
  now: number,
): Promise<SaveOutcome> {
  const outcome = await saveRegular(tx, event, expiresAt);
  if (outcome.type !== "stored") return outcome;

  const req = parseDeletionRequest(event);

  if (req.eventIds.length > 0) {
    // Delete any stored targets authored by the kind-5's pubkey. A kind-5
    // cannot delete another kind-5 per NIP-09 ("deletion of a deletion has
    // no effect"), so we explicitly exclude them.
    const storedTargets = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          inArray(events.id, req.eventIds),
          eq(events.pubkey, event.pubkey),
          ne(events.kind, KIND_DELETION),
        ),
      );
    const storedIds = new Set(storedTargets.map((t) => t.id));

    if (storedIds.size > 0) {
      await tx.delete(events).where(inArray(events.id, Array.from(storedIds)));
    }

    // Tombstone every target id the kind-5 named (both stored-and-deleted and
    // not-yet-seen). The tombstone is keyed on the kind-5 author's pubkey,
    // so a late-arriving event is only blocked when its own pubkey matches —
    // preventing a DoS where random kind-5s would block other authors' ids.
    if (req.eventIds.length > 0) {
      await tx
        .insert(deletedEvents)
        .values(
          req.eventIds.map((id) => ({
            eventId: id,
            pubkey: event.pubkey,
            deletedAt: now,
            deletedByEvent: event.id,
          })),
        )
        .onConflictDoNothing();
    }
  }

  for (const addr of req.addressables) {
    if (addr.pubkey !== event.pubkey) continue;
    // `a` tags only apply to replaceable / addressable kinds per NIP-01. A
    // kind-5 with an `a` tag pointing at a regular kind is silently ignored
    // (otherwise empty-d coordinate matching would nuke every regular event
    // by that author).
    const targetClass = classifyKind(addr.kind);
    if (targetClass !== "addressable" && targetClass !== "replaceable") continue;
    await applyAddressableDeletion(tx, event, addr, now);
  }

  return outcome;
}

async function applyAddressableDeletion(
  tx: Tx,
  kind5: NostrEvent,
  addr: AddressableTarget,
  now: number,
): Promise<void> {
  // Find existing events with the same (pubkey, kind) created at or before
  // the kind-5. Resolve each candidate's coordinate using only the FIRST
  // d-tag per event — the same rule `saveAddressable` uses to decide which
  // coordinate an event belongs to. Using any d-tag here would delete events
  // the store considers to belong to a different coordinate.
  const candidates = await tx
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.pubkey, addr.pubkey),
        eq(events.kind, addr.kind),
        lte(events.createdAt, kind5.created_at),
      ),
    );

  const candidatesWithD = await Promise.all(
    candidates.map(async (c) => {
      const rows = await tx
        .select({ value: eventTags.value })
        .from(eventTags)
        .where(and(eq(eventTags.eventId, c.id), eq(eventTags.name, "d")))
        .orderBy(asc(eventTags.position))
        .limit(1);
      return { id: c.id, d: rows[0]?.value ?? "" };
    }),
  );

  const toDelete = candidatesWithD.filter((c) => c.d === addr.dTag).map((c) => c.id);

  if (toDelete.length > 0) {
    await tx.delete(events).where(inArray(events.id, toDelete));
  }

  await tx
    .insert(deletedAddressable)
    .values({
      pubkey: addr.pubkey,
      kind: addr.kind,
      dTag: addr.dTag,
      deletedUpTo: kind5.created_at,
      insertedAt: now,
      deletedByEvent: kind5.id,
    })
    .onConflictDoUpdate({
      target: [deletedAddressable.pubkey, deletedAddressable.kind, deletedAddressable.dTag],
      set: {
        deletedUpTo: sql`GREATEST(${deletedAddressable.deletedUpTo}, EXCLUDED.deleted_up_to)`,
        // Refresh insertedAt whenever a tombstone is touched, so the pruner
        // measures age from the most recent activity — not the first record.
        insertedAt: sql`EXCLUDED.inserted_at`,
        deletedByEvent: sql`CASE WHEN EXCLUDED.deleted_up_to > ${deletedAddressable.deletedUpTo} THEN EXCLUDED.deleted_by_event ELSE ${deletedAddressable.deletedByEvent} END`,
      },
    });
}

function losesTo(existing: { id: string; createdAt: number }, incoming: NostrEvent): boolean {
  if (existing.createdAt < incoming.created_at) return true;
  if (existing.createdAt > incoming.created_at) return false;
  return existing.id > incoming.id;
}
