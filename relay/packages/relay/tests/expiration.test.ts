import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventStore } from "../src/store.ts";
import { collect, makeDb, sign, truncate } from "./helpers.ts";

const { db, client } = makeDb();

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncate(db);
});

const NOW = 1_700_000_000;
const fixedClock = () => NOW;

describe("NIP-40: save-side rejection", () => {
  test("accepts events with future expiration", async () => {
    const store = new EventStore(db, { now: fixedClock });
    const e = sign({
      kind: 1,
      tags: [["expiration", String(NOW + 3600)]],
    });
    expect(await store.save(e)).toEqual({ type: "stored" });
  });

  test("rejects events with past expiration as 'expired'", async () => {
    const store = new EventStore(db, { now: fixedClock });
    const e = sign({
      kind: 1,
      tags: [["expiration", String(NOW - 1)]],
    });
    expect(await store.save(e)).toEqual({ type: "expired" });
  });

  test("rejects events where expiration == now", async () => {
    const store = new EventStore(db, { now: fixedClock });
    const e = sign({
      kind: 1,
      tags: [["expiration", String(NOW)]],
    });
    expect(await store.save(e)).toEqual({ type: "expired" });
  });

  test("rejects events with a malformed expiration tag", async () => {
    const store = new EventStore(db, { now: fixedClock });
    const e = sign({
      kind: 1,
      tags: [["expiration", "not-a-number"]],
    });
    expect(await store.save(e)).toEqual({
      type: "invalid",
      reason: "malformed expiration tag",
    });
  });
});

describe("NIP-40: query-side filtering", () => {
  test("expired events are not returned", async () => {
    // Seed with the clock at NOW so the event is accepted...
    const seedStore = new EventStore(db, { now: () => NOW });
    const e = sign({
      kind: 1,
      tags: [["expiration", String(NOW + 10)]],
    });
    await seedStore.save(e);

    // ...then query with the clock advanced past expiration.
    const readStore = new EventStore(db, { now: () => NOW + 100 });
    const found = await collect(readStore.query([{ kinds: [1] }]));
    expect(found).toHaveLength(0);
  });

  test("non-expired events are returned", async () => {
    const seedStore = new EventStore(db, { now: () => NOW });
    const e = sign({
      kind: 1,
      tags: [["expiration", String(NOW + 10_000)]],
    });
    await seedStore.save(e);

    const readStore = new EventStore(db, { now: () => NOW + 100 });
    const found = await collect(readStore.query([{ kinds: [1] }]));
    expect(found.map((x) => x.id)).toEqual([e.id]);
  });

  test("events without expiration are always returned", async () => {
    const store = new EventStore(db, { now: fixedClock });
    const e = sign({ kind: 1 });
    await store.save(e);

    const found = await collect(store.query([{ kinds: [1] }]));
    expect(found).toHaveLength(1);
  });
});
