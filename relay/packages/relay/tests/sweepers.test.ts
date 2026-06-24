import { deletedAddressable, deletedEvents } from "@relay/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { KIND_DELETION } from "../src/domain/deletion.ts";
import { EventStore } from "../src/store.ts";
import { collect, freshKey, makeDb, sign, truncate } from "./helpers.ts";

const { db, client } = makeDb();

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncate(db);
});

const NOW = 1_700_000_000;

describe("sweepExpired", () => {
  test("removes only events whose expires_at is <= now", async () => {
    const seed = new EventStore(db, { now: () => NOW });
    const expired = sign({ kind: 1, tags: [["expiration", String(NOW + 10)]] });
    const alive = sign({ kind: 1, tags: [["expiration", String(NOW + 10_000)]] });
    const noExpiry = sign({ kind: 1 });
    await seed.save(expired);
    await seed.save(alive);
    await seed.save(noExpiry);

    // Advance the clock so `expired` is past but `alive` is not.
    const sweeper = new EventStore(db, { now: () => NOW + 100 });
    const result = await sweeper.sweepExpired();
    expect(result.removed).toBe(1);

    const remaining = await collect(sweeper.query([{ kinds: [1] }]));
    expect(remaining.map((e) => e.id).sort()).toEqual([alive.id, noExpiry.id].sort());
  });

  test("returns { removed: 0 } when nothing is expired", async () => {
    const store = new EventStore(db, { now: () => NOW });
    await store.save(sign({ kind: 1 }));
    const result = await store.sweepExpired();
    expect(result).toEqual({ removed: 0 });
  });
});

describe("pruneTombstones", () => {
  test("removes tombstones older than the cutoff", async () => {
    const { sk } = freshKey();
    // Two distinct events (different content → different ids) deleted at
    // different times.
    const old = sign({ kind: 1, secretKey: sk, content: "old", created_at: NOW - 20_000 });
    const recent = sign({ kind: 1, secretKey: sk, content: "recent", created_at: NOW - 200 });

    const storeAtOld = new EventStore(db, { now: () => NOW - 10_000 });
    await storeAtOld.save(old);
    const deleteOld = sign({
      kind: KIND_DELETION,
      tags: [["e", old.id]],
      created_at: NOW - 10_000,
      secretKey: sk,
    });
    await storeAtOld.save(deleteOld);

    const storeAtRecent = new EventStore(db, { now: () => NOW - 100 });
    await storeAtRecent.save(recent);
    const deleteRecent = sign({
      kind: KIND_DELETION,
      tags: [["e", recent.id]],
      created_at: NOW - 100,
      secretKey: sk,
    });
    await storeAtRecent.save(deleteRecent);

    // Prune anything older than 1000 seconds — should drop the `old` tombstone
    // but keep the `recent` one.
    const pruner = new EventStore(db, { now: () => NOW });
    const result = await pruner.pruneTombstones(1000);
    expect(result.events).toBe(1);

    const rows = await db.select({ id: deletedEvents.eventId }).from(deletedEvents);
    expect(rows.map((r) => r.id)).toEqual([recent.id]);
  });

  test("backfilled addressable deletion is NOT pruned based on kind-5 created_at", async () => {
    // Scenario: a replayed kind-5 whose `created_at` is years in the past
    // but which we just received. Tombstone must be kept because we recorded
    // it seconds ago, even though `deleted_up_to` is ancient.
    const { sk, pubkey } = freshKey();

    // Record the tombstone RIGHT NOW even though the kind-5 claims to be old.
    const pruner = new EventStore(db, { now: () => NOW });
    const oldArticle = sign({
      kind: 30023,
      tags: [["d", "backfilled"]],
      secretKey: sk,
      created_at: NOW - 100_000,
    });
    await pruner.save(oldArticle);
    const replayedDel = sign({
      kind: KIND_DELETION,
      tags: [["a", `30023:${pubkey}:backfilled`]],
      created_at: NOW - 50_000, // very old kind-5
      secretKey: sk,
    });
    await pruner.save(replayedDel); // inserted_at = NOW

    // Prune with a 1000-second TTL. The tombstone is seconds old by
    // inserted_at, so it must survive.
    const result = await pruner.pruneTombstones(1000);
    expect(result.addressables).toBe(0);

    const rows = await db.select().from(deletedAddressable);
    expect(rows).toHaveLength(1);
  });

  test("removes addressable tombstones whose inserted_at is older than cutoff", async () => {
    const { sk, pubkey } = freshKey();

    const storeAtOld = new EventStore(db, { now: () => NOW - 10_000 });
    const oldArticle = sign({
      kind: 30023,
      tags: [["d", "old"]],
      secretKey: sk,
      created_at: NOW - 10_100,
    });
    await storeAtOld.save(oldArticle);
    const oldDel = sign({
      kind: KIND_DELETION,
      tags: [["a", `30023:${pubkey}:old`]],
      created_at: NOW - 10_000,
      secretKey: sk,
    });
    await storeAtOld.save(oldDel);

    const pruner = new EventStore(db, { now: () => NOW });
    const result = await pruner.pruneTombstones(1000);
    expect(result.addressables).toBe(1);

    const rows = await db.select().from(deletedAddressable);
    expect(rows).toHaveLength(0);
  });

  test("after pruning, the same event can be re-published by the author", async () => {
    const { sk } = freshKey();
    const storeAtOld = new EventStore(db, { now: () => NOW - 10_000 });
    const original = sign({ kind: 1, secretKey: sk, created_at: NOW - 10_500 });
    await storeAtOld.save(original);
    await storeAtOld.save(
      sign({
        kind: KIND_DELETION,
        tags: [["e", original.id]],
        created_at: NOW - 10_000,
        secretKey: sk,
      }),
    );

    // Before pruning, re-publish is blocked.
    const storeNow = new EventStore(db, { now: () => NOW });
    expect(await storeNow.save(original)).toEqual({
      type: "blocked",
      reason: "user requested deletion",
    });

    await storeNow.pruneTombstones(1000);

    // After pruning the stale tombstone, the same event can land again.
    expect(await storeNow.save(original)).toEqual({ type: "stored" });
  });

  test("returns zeros when nothing to prune", async () => {
    const store = new EventStore(db, { now: () => NOW });
    // Make sure tombstone tables are empty.
    await db.execute(sql`TRUNCATE TABLE ${deletedEvents}, ${deletedAddressable}`);
    const result = await store.pruneTombstones(1000);
    expect(result).toEqual({ events: 0, addressables: 0 });
  });
});
