import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventStore } from "../src/store.ts";
import { collect, freshKey, makeDb, sign, truncate } from "./helpers.ts";

const { db, client } = makeDb();
const store = new EventStore(db);

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncate(db);
});

describe("NIP-09: e-tag deletion of own events", () => {
  test("deletes a target event authored by the same pubkey", async () => {
    const { sk } = freshKey();
    const target = sign({ kind: 1, content: "oops", secretKey: sk });
    await store.save(target);

    const del = sign({
      kind: 5,
      tags: [["e", target.id]],
      content: "retraction",
      secretKey: sk,
    });
    expect(await store.save(del)).toEqual({ type: "stored" });

    const found = await collect(store.query([{ ids: [target.id] }]));
    expect(found).toHaveLength(0);
  });

  test("still stores the kind-5 itself (relays should replicate deletions)", async () => {
    const { sk } = freshKey();
    const target = sign({ kind: 1, content: "oops", secretKey: sk });
    await store.save(target);

    const del = sign({ kind: 5, tags: [["e", target.id]], secretKey: sk });
    await store.save(del);

    const found = await collect(store.query([{ ids: [del.id] }]));
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(5);
  });

  test("re-publishing a deleted event is blocked", async () => {
    const { sk } = freshKey();
    const target = sign({ kind: 1, content: "x", secretKey: sk });
    await store.save(target);

    const del = sign({ kind: 5, tags: [["e", target.id]], secretKey: sk });
    await store.save(del);

    const result = await store.save(target);
    expect(result).toEqual({ type: "blocked", reason: "user requested deletion" });
  });
});

describe("NIP-09: cannot delete someone else's event", () => {
  test("target is not deleted when the deletion author differs", async () => {
    const alice = freshKey();
    const bob = freshKey();
    const aliceEvent = sign({ kind: 1, secretKey: alice.sk });
    await store.save(aliceEvent);

    // Bob tries to delete Alice's event.
    const del = sign({
      kind: 5,
      tags: [["e", aliceEvent.id]],
      secretKey: bob.sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ ids: [aliceEvent.id] }]));
    expect(found).toHaveLength(1);
  });
});

describe("NIP-09: cannot delete a kind-5", () => {
  test("kind-5 targeting another kind-5 has no effect on the target", async () => {
    const { sk } = freshKey();
    const victim = sign({ kind: 1, secretKey: sk });
    await store.save(victim);

    const firstDeletion = sign({
      kind: 5,
      tags: [["e", victim.id]],
      secretKey: sk,
    });
    await store.save(firstDeletion);

    // Try to delete the deletion — should be a no-op on the deletion itself.
    const secondDeletion = sign({
      kind: 5,
      tags: [["e", firstDeletion.id]],
      secretKey: sk,
    });
    await store.save(secondDeletion);

    const found = await collect(store.query([{ ids: [firstDeletion.id] }]));
    expect(found).toHaveLength(1);
  });
});

describe("NIP-09: a-tag deletion of addressable events", () => {
  test("deletes all versions at or before the kind-5's created_at", async () => {
    const { sk, pubkey } = freshKey();
    const v1 = sign({
      kind: 30023,
      created_at: 1000,
      tags: [["d", "my-article"]],
      secretKey: sk,
      content: "v1",
    });
    await store.save(v1);

    const del = sign({
      kind: 5,
      created_at: 2000,
      tags: [["a", `30023:${pubkey}:my-article`]],
      secretKey: sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ kinds: [30023] }]));
    expect(found).toHaveLength(0);
  });

  test("re-publish older than deletion horizon is blocked", async () => {
    const { sk, pubkey } = freshKey();
    const v1 = sign({
      kind: 30023,
      created_at: 1000,
      tags: [["d", "my-article"]],
      secretKey: sk,
    });
    await store.save(v1);

    const del = sign({
      kind: 5,
      created_at: 2000,
      tags: [["a", `30023:${pubkey}:my-article`]],
      secretKey: sk,
    });
    await store.save(del);

    // Same version re-published.
    expect(await store.save(v1)).toEqual({
      type: "blocked",
      reason: "user requested deletion",
    });
  });

  test("a newer version (created_at > deletedUpTo) can be published", async () => {
    const { sk, pubkey } = freshKey();
    const v1 = sign({
      kind: 30023,
      created_at: 1000,
      tags: [["d", "my-article"]],
      secretKey: sk,
    });
    await store.save(v1);

    const del = sign({
      kind: 5,
      created_at: 2000,
      tags: [["a", `30023:${pubkey}:my-article`]],
      secretKey: sk,
    });
    await store.save(del);

    const v2 = sign({
      kind: 30023,
      created_at: 3000,
      tags: [["d", "my-article"]],
      secretKey: sk,
      content: "v2",
    });
    expect(await store.save(v2)).toEqual({ type: "stored" });

    const found = await collect(store.query([{ kinds: [30023] }]));
    expect(found.map((e) => e.id)).toEqual([v2.id]);
  });

  test("a-tag for a different d-tag does not delete siblings", async () => {
    const { sk, pubkey } = freshKey();
    const keep = sign({
      kind: 30023,
      created_at: 1000,
      tags: [["d", "other"]],
      secretKey: sk,
    });
    const gone = sign({
      kind: 30023,
      created_at: 1000,
      tags: [["d", "target"]],
      secretKey: sk,
    });
    await store.save(keep);
    await store.save(gone);

    const del = sign({
      kind: 5,
      created_at: 2000,
      tags: [["a", `30023:${pubkey}:target`]],
      secretKey: sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ kinds: [30023] }]));
    expect(found.map((e) => e.id)).toEqual([keep.id]);
  });

  test("a-tag with mismatched pubkey in coord is ignored", async () => {
    const alice = freshKey();
    const bob = freshKey();
    const aliceArticle = sign({
      kind: 30023,
      tags: [["d", "x"]],
      secretKey: alice.sk,
    });
    await store.save(aliceArticle);

    // Bob crafts a kind-5 that references Alice's coordinate.
    const del = sign({
      kind: 5,
      created_at: aliceArticle.created_at + 1,
      tags: [["a", `30023:${alice.pubkey}:x`]],
      secretKey: bob.sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ kinds: [30023] }]));
    expect(found).toHaveLength(1);
  });
});

describe("NIP-09: a-tags are ignored for regular kinds", () => {
  test("an a-tag pointing at a regular kind does not delete kind-1 events", async () => {
    const { sk, pubkey } = freshKey();
    const note = sign({ kind: 1, secretKey: sk, content: "survive" });
    await store.save(note);

    // A misused a-tag for a regular kind — would otherwise match every
    // kind-1 without a d-tag via the empty-d coordinate.
    const del = sign({
      kind: 5,
      created_at: note.created_at + 1,
      tags: [["a", `1:${pubkey}:`]],
      secretKey: sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ kinds: [1] }]));
    expect(found.map((e) => e.id)).toEqual([note.id]);
  });
});

describe("NIP-09: tombstone for unseen targets", () => {
  test("publish-after-deletion (by the same author) is blocked", async () => {
    const { sk } = freshKey();
    // The target event exists but is not yet stored on this relay.
    const target = sign({ kind: 1, secretKey: sk, content: "x" });

    // Deletion arrives first, without the target.
    const del = sign({
      kind: 5,
      tags: [["e", target.id]],
      secretKey: sk,
    });
    expect(await store.save(del)).toEqual({ type: "stored" });

    // Now the target tries to land — should be blocked.
    const result = await store.save(target);
    expect(result).toEqual({ type: "blocked", reason: "user requested deletion" });
  });

  test("a tombstone does not block a different author's event with the same id shape", async () => {
    const alice = freshKey();
    const bob = freshKey();
    const aliceTarget = sign({ kind: 1, secretKey: alice.sk, content: "hi" });

    // Alice publishes a deletion naming an id she doesn't own — attempt to
    // blanket-block that id for anyone else.
    const victimId = sign({ kind: 1, secretKey: bob.sk, content: "victim" }).id;
    const blanketDel = sign({
      kind: 5,
      tags: [["e", victimId]],
      secretKey: alice.sk,
    });
    await store.save(blanketDel);

    // Bob's real event with that id can still land — the tombstone's pubkey
    // is Alice's, so it only blocks Alice.
    const bobsEvent = sign({ kind: 1, secretKey: bob.sk, content: "victim" });
    // Force the id by re-creating: bobsEvent.id is derived from content+pubkey+ts,
    // so we just publish a legitimate event with whatever id it naturally gets.
    // The test's point: Bob's publishing path is never touched by Alice's
    // blanket tombstone, so `save` succeeds.
    expect(await store.save(bobsEvent)).toEqual({ type: "stored" });
    expect(await store.save(aliceTarget)).toEqual({ type: "stored" });
  });
});

describe("NIP-09: addressable deletion uses only the first d-tag", () => {
  test("event with multiple d-tags is matched against its first d-tag only", async () => {
    const { sk, pubkey } = freshKey();
    // The event has two d-tags — saveAddressable stores it under "keep".
    const dual = sign({
      kind: 30023,
      secretKey: sk,
      tags: [
        ["d", "keep"],
        ["d", "target"],
      ],
    });
    await store.save(dual);

    // Deletion request targets the SECOND d-tag value.
    const del = sign({
      kind: 5,
      created_at: dual.created_at + 1,
      tags: [["a", `30023:${pubkey}:target`]],
      secretKey: sk,
    });
    await store.save(del);

    // The event should still exist — the store considers it bound to "keep".
    const found = await collect(store.query([{ kinds: [30023] }]));
    expect(found.map((e) => e.id)).toEqual([dual.id]);
  });
});

describe("NIP-09: a-tag deletion of replaceable events (empty d)", () => {
  test("deletes a kind-0 via coord with empty d-tag", async () => {
    const { sk, pubkey } = freshKey();
    const profile = sign({ kind: 0, secretKey: sk, content: "{}" });
    await store.save(profile);

    const del = sign({
      kind: 5,
      created_at: profile.created_at + 1,
      tags: [["a", `0:${pubkey}:`]],
      secretKey: sk,
    });
    await store.save(del);

    const found = await collect(store.query([{ kinds: [0] }]));
    expect(found).toHaveLength(0);
  });
});
