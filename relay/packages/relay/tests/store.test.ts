import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventStore } from "../src/store.ts";
import { collect, freshKey, makeDb, sign, truncate } from "./helpers.ts";

const { db, client } = makeDb();
const store = new EventStore(db);

beforeAll(async () => {
  await truncate(db);
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncate(db);
});

describe("EventStore.save: regular events (kind 1)", () => {
  test("stores a new event", async () => {
    const e = sign({ kind: 1, content: "hi" });
    expect(await store.save(e)).toEqual({ type: "stored" });
  });

  test("reports duplicate when the same id already exists", async () => {
    const e = sign({ kind: 1 });
    await store.save(e);
    expect(await store.save(e)).toEqual({ type: "duplicate" });
  });

  test("persists tags in order", async () => {
    const e = sign({
      kind: 1,
      tags: [
        ["e", "deadbeef", "wss://relay"],
        ["p", "feedface"],
      ],
    });
    await store.save(e);
    const [found] = await collect(store.query([{ ids: [e.id] }]));
    expect(found?.tags).toEqual([
      ["e", "deadbeef", "wss://relay"],
      ["p", "feedface"],
    ]);
  });
});

describe("EventStore.save: replaceable events (kind 0, 3, 10000-19999)", () => {
  test("a newer replaceable event replaces the older one", async () => {
    const { sk } = freshKey();
    const older = sign({ kind: 0, created_at: 1000, secretKey: sk, content: "old" });
    const newer = sign({ kind: 0, created_at: 2000, secretKey: sk, content: "new" });

    expect(await store.save(older)).toEqual({ type: "stored" });
    expect(await store.save(newer)).toEqual({ type: "replaced", removed: 1 });

    const all = await collect(store.query([{ kinds: [0] }]));
    expect(all.map((e) => e.id)).toEqual([newer.id]);
  });

  test("an older replaceable event is outdated", async () => {
    const { sk } = freshKey();
    const newer = sign({ kind: 0, created_at: 2000, secretKey: sk });
    const older = sign({ kind: 0, created_at: 1000, secretKey: sk });

    await store.save(newer);
    expect(await store.save(older)).toEqual({ type: "outdated" });

    const all = await collect(store.query([{ kinds: [0] }]));
    expect(all.map((e) => e.id)).toEqual([newer.id]);
  });

  test("on created_at tie, the event with the lower id wins", async () => {
    const { sk } = freshKey();
    // generate two events with the same created_at and keep whichever pair has distinct ids
    const a = sign({ kind: 0, created_at: 1000, secretKey: sk, content: "a" });
    const b = sign({ kind: 0, created_at: 1000, secretKey: sk, content: "b" });
    const [lower, higher] = a.id < b.id ? [a, b] : [b, a];

    await store.save(higher);
    expect(await store.save(lower)).toEqual({ type: "replaced", removed: 1 });

    const all = await collect(store.query([{ kinds: [0] }]));
    expect(all.map((e) => e.id)).toEqual([lower.id]);
  });

  test("per (pubkey, kind): two different authors each keep their own replaceable", async () => {
    const author1 = freshKey();
    const author2 = freshKey();
    const e1 = sign({ kind: 0, secretKey: author1.sk });
    const e2 = sign({ kind: 0, secretKey: author2.sk });

    await store.save(e1);
    await store.save(e2);

    const all = await collect(store.query([{ kinds: [0] }]));
    expect(all).toHaveLength(2);
  });
});

describe("EventStore.save: ephemeral events (kind 20000-29999)", () => {
  test("not persisted, outcome is ephemeral", async () => {
    const e = sign({ kind: 20000 });
    expect(await store.save(e)).toEqual({ type: "ephemeral" });
    const all = await collect(store.query([{ kinds: [20000] }]));
    expect(all).toHaveLength(0);
  });
});

describe("EventStore.save: addressable events (kind 30000-39999)", () => {
  test("different d tags coexist under the same (pubkey, kind)", async () => {
    const { sk } = freshKey();
    const e1 = sign({ kind: 30000, tags: [["d", "article-1"]], secretKey: sk });
    const e2 = sign({ kind: 30000, tags: [["d", "article-2"]], secretKey: sk });

    expect(await store.save(e1)).toEqual({ type: "stored" });
    expect(await store.save(e2)).toEqual({ type: "stored" });

    const all = await collect(store.query([{ kinds: [30000] }]));
    expect(all).toHaveLength(2);
  });

  test("same d tag replaces older", async () => {
    const { sk } = freshKey();
    const older = sign({
      kind: 30000,
      created_at: 1000,
      tags: [["d", "article"]],
      secretKey: sk,
      content: "old",
    });
    const newer = sign({
      kind: 30000,
      created_at: 2000,
      tags: [["d", "article"]],
      secretKey: sk,
      content: "new",
    });

    await store.save(older);
    expect(await store.save(newer)).toEqual({ type: "replaced", removed: 1 });

    const [found] = await collect(store.query([{ kinds: [30000] }]));
    expect(found?.content).toBe("new");
  });

  test("missing d tag is equivalent to d=''", async () => {
    const { sk } = freshKey();
    const without = sign({ kind: 30000, created_at: 1000, secretKey: sk });
    const withEmpty = sign({
      kind: 30000,
      created_at: 2000,
      tags: [["d", ""]],
      secretKey: sk,
    });

    await store.save(without);
    expect(await store.save(withEmpty)).toEqual({ type: "replaced", removed: 1 });
  });
});

describe("EventStore.query: filters", () => {
  test("empty filter list returns nothing", async () => {
    await store.save(sign({ kind: 1 }));
    expect(await collect(store.query([]))).toHaveLength(0);
  });

  test("ids filter", async () => {
    const e1 = sign({ kind: 1, content: "one" });
    const e2 = sign({ kind: 1, content: "two" });
    await store.save(e1);
    await store.save(e2);
    const found = await collect(store.query([{ ids: [e1.id] }]));
    expect(found.map((e) => e.id)).toEqual([e1.id]);
  });

  test("authors filter", async () => {
    const author = freshKey();
    const other = freshKey();
    const mine = sign({ kind: 1, secretKey: author.sk });
    const theirs = sign({ kind: 1, secretKey: other.sk });
    await store.save(mine);
    await store.save(theirs);
    const found = await collect(store.query([{ authors: [author.pubkey] }]));
    expect(found.map((e) => e.id)).toEqual([mine.id]);
  });

  test("kinds filter", async () => {
    const k1 = sign({ kind: 1 });
    const k7 = sign({ kind: 7 });
    await store.save(k1);
    await store.save(k7);
    const found = await collect(store.query([{ kinds: [7] }]));
    expect(found.map((e) => e.id)).toEqual([k7.id]);
  });

  test("since and until are inclusive", async () => {
    const e = sign({ kind: 1, created_at: 1000 });
    await store.save(e);
    expect(await collect(store.query([{ since: 1000, until: 1000 }]))).toHaveLength(1);
    expect(await collect(store.query([{ since: 1001 }]))).toHaveLength(0);
    expect(await collect(store.query([{ until: 999 }]))).toHaveLength(0);
  });

  test("single-letter tag filter via #e", async () => {
    const target = sign({ kind: 1, tags: [["e", "deadbeef"]] });
    const other = sign({ kind: 1, tags: [["p", "deadbeef"]] });
    await store.save(target);
    await store.save(other);
    const found = await collect(store.query([{ "#e": ["deadbeef"] }]));
    expect(found.map((e) => e.id)).toEqual([target.id]);
  });

  test("only the first value of a tag is indexed", async () => {
    const e = sign({ kind: 1, tags: [["e", "first", "second"]] });
    await store.save(e);
    expect(await collect(store.query([{ "#e": ["first"] }]))).toHaveLength(1);
    expect(await collect(store.query([{ "#e": ["second"] }]))).toHaveLength(0);
  });

  test("empty ids/authors/kinds/tag arrays match nothing", async () => {
    await store.save(sign({ kind: 1 }));
    expect(await collect(store.query([{ ids: [] }]))).toHaveLength(0);
    expect(await collect(store.query([{ authors: [] }]))).toHaveLength(0);
    expect(await collect(store.query([{ kinds: [] }]))).toHaveLength(0);
    expect(await collect(store.query([{ "#e": [] }]))).toHaveLength(0);
  });

  test("multiple filters are ORed and results deduplicated", async () => {
    const e1 = sign({ kind: 1, content: "one" });
    const e2 = sign({ kind: 7, content: "two" });
    await store.save(e1);
    await store.save(e2);
    const found = await collect(store.query([{ kinds: [1] }, { kinds: [7] }, { kinds: [1, 7] }]));
    expect(found).toHaveLength(2);
  });
});

describe("EventStore.query: ordering and limits", () => {
  test("orders by created_at DESC then id ASC", async () => {
    const a = sign({ kind: 1, created_at: 1000, content: "a" });
    const b = sign({ kind: 1, created_at: 2000, content: "b" });
    const c = sign({ kind: 1, created_at: 2000, content: "c" });
    await store.save(a);
    await store.save(b);
    await store.save(c);

    const found = await collect(store.query([{ kinds: [1] }]));
    expect(found[0]?.created_at).toBe(2000);
    expect(found[1]?.created_at).toBe(2000);
    expect(found[2]?.created_at).toBe(1000);
    const tiedIds = [found[0]!.id, found[1]!.id];
    expect([...tiedIds].sort()).toEqual(tiedIds);
  });

  test("honors per-filter limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(sign({ kind: 1, created_at: 1000 + i, content: `e${i}` }));
    }
    const found = await collect(store.query([{ kinds: [1], limit: 2 }]));
    expect(found).toHaveLength(2);
  });

  test("defaultLimit caps filters with no explicit limit", async () => {
    const tight = new EventStore(db, { defaultLimit: 2 });
    for (let i = 0; i < 5; i++) {
      await store.save(sign({ kind: 1, created_at: 1000 + i, content: `e${i}` }));
    }
    const found = await collect(tight.query([{ kinds: [1] }]));
    expect(found).toHaveLength(2);
  });
});
