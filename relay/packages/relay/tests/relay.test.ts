import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { KIND_AUTH } from "../src/domain/auth.ts";
import { SubscriptionRegistry } from "../src/domain/subscription.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { createRelay, type OutgoingMessage } from "../src/relay.ts";
import { EventStore } from "../src/store.ts";
import { collect, freshKey, makeDb, sign, truncate } from "./helpers.ts";

const { db, client } = makeDb();
const store = new EventStore(db);

afterAll(async () => {
  await client.end();
});

let registry: SubscriptionRegistry;
let relay: ReturnType<typeof createRelay>;

beforeEach(async () => {
  await truncate(db);
  registry = new SubscriptionRegistry();
  relay = createRelay({ store, registry });
});

async function send(connId: string, raw: unknown): Promise<OutgoingMessage[]> {
  return await collect(relay.handleClientMessage(connId, raw));
}

describe("malformed client messages", () => {
  test("invalid JSON yields a NOTICE", async () => {
    const out = await send("conn-a", "not json");
    expect(out).toHaveLength(1);
    expect(out[0]?.message.type).toBe("NOTICE");
  });

  test("unknown message type yields a NOTICE", async () => {
    const out = await send("conn-a", ["FOO", "x"]);
    expect(out[0]?.message.type).toBe("NOTICE");
  });
});

describe("EVENT: validation", () => {
  test("accepted regular event yields OK(true, '')", async () => {
    const e = sign({ kind: 1 });
    const out = await send("conn-a", ["EVENT", e]);
    expect(out).toEqual([
      { connId: "conn-a", message: { type: "OK", eventId: e.id, accepted: true, message: "" } },
    ]);
  });

  test("forged signature yields OK(false, 'invalid: ...')", async () => {
    const real = sign({ kind: 1 });
    const forged = { ...real, sig: "f".repeat(128) };
    const out = await send("conn-a", ["EVENT", forged]);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^invalid:/);
    }
  });

  test("missing id uses empty string in OK", async () => {
    const out = await send("conn-a", ["EVENT", { not: "valid" }]);
    expect(out[0]?.message).toMatchObject({ type: "OK", eventId: "", accepted: false });
  });

  test("duplicate EVENT yields OK(true, 'duplicate: ...')", async () => {
    const e = sign({ kind: 1 });
    await send("conn-a", ["EVENT", e]);
    const out = await send("conn-a", ["EVENT", e]);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: true });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^duplicate:/);
    }
  });
});

describe("EVENT: broadcast to matching subscribers", () => {
  test("delivers to another conn with a matching REQ", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [1] }]);
    const e = sign({ kind: 1, content: "hello world" });
    const out = await send("sender", ["EVENT", e]);

    const broadcasts = out.filter((m) => m.message.type === "EVENT");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      connId: "listener",
      message: { type: "EVENT", subscriptionId: "sub1", event: e },
    });
    expect(out.filter((m) => m.message.type === "OK")).toHaveLength(1);
  });

  test("does not deliver to a conn whose filters do not match", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [7] }]);
    const e = sign({ kind: 1 });
    const out = await send("sender", ["EVENT", e]);
    expect(out.filter((m) => m.message.type === "EVENT")).toHaveLength(0);
  });

  test("delivers to the sender when they have a matching subscription", async () => {
    await send("self", ["REQ", "sub1", { kinds: [1] }]);
    const e = sign({ kind: 1 });
    const out = await send("self", ["EVENT", e]);
    const broadcastToSelf = out.filter((m) => m.connId === "self" && m.message.type === "EVENT");
    expect(broadcastToSelf).toHaveLength(1);
  });

  test("OK is yielded before broadcasts", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [1] }]);
    const e = sign({ kind: 1 });
    const out = await send("sender", ["EVENT", e]);
    expect(out[0]?.message.type).toBe("OK");
    expect(out[1]?.message.type).toBe("EVENT");
  });
});

describe("EVENT: ephemeral kind 20000-29999", () => {
  test("with no listeners: OK(true, 'mute: ...') and not persisted", async () => {
    const e = sign({ kind: 20000 });
    const out = await send("sender", ["EVENT", e]);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: true });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^mute:/);
    }
  });

  test("with a listener: broadcast + OK(true, '')", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [20000] }]);
    const e = sign({ kind: 20000 });
    const out = await send("sender", ["EVENT", e]);
    expect(out.filter((m) => m.message.type === "EVENT")).toHaveLength(1);
    const ok = out.find((m) => m.message.type === "OK");
    expect(ok?.message).toMatchObject({ accepted: true, message: "" });
  });
});

describe("EVENT: replaceable outdated", () => {
  test("outdated event yields OK(true, 'duplicate: have a newer version')", async () => {
    const { sk } = freshKey();
    const newer = sign({ kind: 0, created_at: 2000, secretKey: sk });
    const older = sign({ kind: 0, created_at: 1000, secretKey: sk });
    await send("conn-a", ["EVENT", newer]);
    const out = await send("conn-a", ["EVENT", older]);
    const ok = out.find((m) => m.message.type === "OK");
    expect(ok?.message).toMatchObject({ accepted: true });
    if (ok?.message.type === "OK") {
      expect(ok.message.message).toMatch(/^duplicate:/);
    }
  });
});

describe("REQ: stored events + EOSE", () => {
  test("yields stored matches then EOSE", async () => {
    const e1 = sign({ kind: 1, created_at: 1000 });
    const e2 = sign({ kind: 1, created_at: 2000 });
    await send("loader", ["EVENT", e1]);
    await send("loader", ["EVENT", e2]);

    const out = await send("reader", ["REQ", "sub1", { kinds: [1] }]);
    const types = out.map((m) => m.message.type);
    expect(types).toEqual(["EVENT", "EVENT", "EOSE"]);
    expect(out[out.length - 1]?.message).toEqual({ type: "EOSE", subscriptionId: "sub1" });
  });

  test("yields only EOSE when no events match", async () => {
    const out = await send("reader", ["REQ", "sub1", { kinds: [42] }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.message.type).toBe("EOSE");
  });

  test("REQ with same sub id replaces the previous filters", async () => {
    const author = freshKey();
    const other = freshKey();
    const mine = sign({ kind: 1, secretKey: author.sk });
    await send("loader", ["EVENT", mine]);

    await send("reader", ["REQ", "sub1", { authors: [other.pubkey] }]);
    expect(registry.get("reader", "sub1")).toEqual([{ authors: [other.pubkey] }]);

    await send("reader", ["REQ", "sub1", { authors: [author.pubkey] }]);
    expect(registry.get("reader", "sub1")).toEqual([{ authors: [author.pubkey] }]);
  });
});

describe("CLOSE", () => {
  test("removes the subscription; subsequent EVENT does not broadcast", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [1] }]);
    const closeOut = await send("listener", ["CLOSE", "sub1"]);
    expect(closeOut).toEqual([]);

    const e = sign({ kind: 1 });
    const out = await send("sender", ["EVENT", e]);
    expect(out.filter((m) => m.message.type === "EVENT")).toHaveLength(0);
  });
});

describe("handleDisconnect", () => {
  test("removes all subscriptions for the connection", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [1] }]);
    await send("listener", ["REQ", "sub2", { kinds: [7] }]);
    expect(registry.size()).toBe(2);

    relay.handleDisconnect("listener");
    expect(registry.size()).toBe(0);
  });

  test("does not affect other connections", async () => {
    await send("a", ["REQ", "sub1", { kinds: [1] }]);
    await send("b", ["REQ", "sub1", { kinds: [1] }]);
    relay.handleDisconnect("a");
    expect(registry.has("a", "sub1")).toBe(false);
    expect(registry.has("b", "sub1")).toBe(true);
  });
});

describe("rate limiting", () => {
  test("EVENT is rejected with 'rate-limited' once the bucket empties", async () => {
    let now = 0;
    const limiter = new RateLimiter({ tokensPerSecond: 0, burst: 1, now: () => now });
    const localReg = new SubscriptionRegistry();
    const localRelay = createRelay({
      store,
      registry: localReg,
      eventRateLimiter: limiter,
    });

    const e1 = sign({ kind: 1, content: "one" });
    const out1 = await collect(localRelay.handleClientMessage("conn-a", ["EVENT", e1]));
    expect(out1[0]?.message).toMatchObject({ type: "OK", accepted: true });

    const e2 = sign({ kind: 1, content: "two" });
    const out2 = await collect(localRelay.handleClientMessage("conn-a", ["EVENT", e2]));
    expect(out2[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out2[0]?.message.type === "OK") {
      expect(out2[0].message.message).toMatch(/^rate-limited:/);
    }
  });

  test("rate limiter gates invalid events too (runs before signature validation)", async () => {
    const limiter = new RateLimiter({ tokensPerSecond: 0, burst: 1 });
    const localReg = new SubscriptionRegistry();
    const localRelay = createRelay({
      store,
      registry: localReg,
      eventRateLimiter: limiter,
    });

    // First forged event consumes the only token and is rejected as invalid.
    const bogus = { id: "a".repeat(64), pubkey: "b".repeat(64), content: "x" };
    const out1 = await collect(localRelay.handleClientMessage("conn-a", ["EVENT", bogus]));
    expect(out1[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out1[0]?.message.type === "OK") expect(out1[0].message.message).toMatch(/^invalid:/);

    // Second forged event hits the empty bucket *before* signature check, so
    // we short-circuit with rate-limited instead of burning CPU on validate.
    const out2 = await collect(localRelay.handleClientMessage("conn-a", ["EVENT", bogus]));
    expect(out2[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out2[0]?.message.type === "OK") expect(out2[0].message.message).toMatch(/^rate-limited:/);
  });

  test("rate limiter bucket is cleared on handleDisconnect", async () => {
    const limiter = new RateLimiter({ tokensPerSecond: 0, burst: 1 });
    const localReg = new SubscriptionRegistry();
    const localRelay = createRelay({
      store,
      registry: localReg,
      eventRateLimiter: limiter,
    });

    const e = sign({ kind: 1 });
    await collect(localRelay.handleClientMessage("conn-a", ["EVENT", e]));
    expect(limiter.size()).toBe(1);
    localRelay.handleDisconnect("conn-a");
    expect(limiter.size()).toBe(0);
  });
});

describe("subscription cap", () => {
  test("REQ beyond maxPerConnection yields CLOSED('rate-limited: ...')", async () => {
    const cappedReg = new SubscriptionRegistry({ maxPerConnection: 1 });
    const cappedRelay = createRelay({ store, registry: cappedReg });

    const out1 = await collect(
      cappedRelay.handleClientMessage("conn-a", ["REQ", "sub1", { kinds: [1] }]),
    );
    expect(out1[out1.length - 1]?.message.type).toBe("EOSE");

    const out2 = await collect(
      cappedRelay.handleClientMessage("conn-a", ["REQ", "sub2", { kinds: [1] }]),
    );
    expect(out2).toHaveLength(1);
    expect(out2[0]?.message.type).toBe("CLOSED");
    if (out2[0]?.message.type === "CLOSED") {
      expect(out2[0].message.message).toMatch(/^rate-limited:/);
    }
  });
});

const RELAY_URL = "wss://test.example/";

describe("NIP-42 AUTH", () => {
  test("handleConnectionOpen yields AUTH with a challenge", async () => {
    const out = await collect(relay.handleConnectionOpen("conn-a"));
    expect(out).toHaveLength(1);
    expect(out[0]?.message.type).toBe("AUTH");
    if (out[0]?.message.type === "AUTH") {
      expect(out[0].message.challenge.length).toBeGreaterThan(10);
    }
  });

  test("AUTH event with correct challenge yields OK(true)", async () => {
    const authRelay = createRelay({ store, registry, relayUrl: RELAY_URL });
    const opened = await collect(authRelay.handleConnectionOpen("conn-a"));
    const challenge = opened[0]?.message.type === "AUTH" ? opened[0].message.challenge : "";

    const { sk } = freshKey();
    const authEvent = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", RELAY_URL],
          ["challenge", challenge],
        ],
        content: "",
      },
      sk,
    );

    const out = await collect(authRelay.handleClientMessage("conn-a", ["AUTH", authEvent]));
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: true });
  });

  test("AUTH with wrong challenge yields OK(false, 'restricted:') and a rotated AUTH", async () => {
    const authRelay = createRelay({ store, registry, relayUrl: RELAY_URL });
    const opened = await collect(authRelay.handleConnectionOpen("conn-a"));
    const firstChallenge = opened[0]?.message.type === "AUTH" ? opened[0].message.challenge : "";

    const { sk } = freshKey();
    const authEvent = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", RELAY_URL],
          ["challenge", "not-the-real-challenge"],
        ],
        content: "",
      },
      sk,
    );

    const out = await collect(authRelay.handleClientMessage("conn-a", ["AUTH", authEvent]));
    expect(out).toHaveLength(2);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^restricted:/);
    }
    expect(out[1]?.message.type).toBe("AUTH");
    if (out[1]?.message.type === "AUTH") {
      expect(out[1].message.challenge).not.toBe(firstChallenge);
    }
  });

  test("kind 22242 sent via EVENT is rejected as invalid (not broadcast, not stored)", async () => {
    await send("listener", ["REQ", "sub1", { kinds: [KIND_AUTH] }]);
    const { sk } = freshKey();
    const authEvent = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", RELAY_URL],
          ["challenge", "anything"],
        ],
        content: "",
      },
      sk,
    );

    const out = await send("sender", ["EVENT", authEvent]);
    // Only an OK for sender — no broadcast to listener.
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^invalid:/);
    }
  });

  test("handleDisconnect clears auth state", async () => {
    const authRelay = createRelay({ store, registry, relayUrl: RELAY_URL });
    const opened = await collect(authRelay.handleConnectionOpen("conn-a"));
    const challenge1 = opened[0]?.message.type === "AUTH" ? opened[0].message.challenge : "";

    authRelay.handleDisconnect("conn-a");

    // After disconnect, a new open issues a fresh challenge.
    const opened2 = await collect(authRelay.handleConnectionOpen("conn-a"));
    const challenge2 = opened2[0]?.message.type === "AUTH" ? opened2[0].message.challenge : "";

    expect(challenge2).not.toBe(challenge1);
  });
});

describe("NIP-42 AuthPolicy hook", () => {
  test("canWrite: returning auth-required gates the EVENT", async () => {
    const policyRelay = createRelay({
      store,
      registry: new SubscriptionRegistry(),
      relayUrl: RELAY_URL,
      authPolicy: {
        canWrite: ({ authenticatedPubkeys }) =>
          authenticatedPubkeys.size > 0
            ? { ok: true }
            : { ok: false, kind: "auth-required", message: "login to write" },
      },
    });

    const e = sign({ kind: 1 });
    const out = await collect(policyRelay.handleClientMessage("conn-a", ["EVENT", e]));
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: false });
    if (out[0]?.message.type === "OK") {
      expect(out[0].message.message).toMatch(/^auth-required:/);
    }
  });

  test("canRead: returning auth-required yields CLOSED on REQ", async () => {
    const policyRelay = createRelay({
      store,
      registry: new SubscriptionRegistry(),
      relayUrl: RELAY_URL,
      authPolicy: {
        canRead: () => ({ ok: false, kind: "auth-required", message: "login to read" }),
      },
    });

    const out = await collect(
      policyRelay.handleClientMessage("conn-a", ["REQ", "sub1", { kinds: [1] }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ type: "CLOSED" });
    if (out[0]?.message.type === "CLOSED") {
      expect(out[0].message.message).toMatch(/^auth-required:/);
    }
  });

  test("canWrite: once authenticated, the same event is accepted", async () => {
    const policyRelay = createRelay({
      store,
      registry: new SubscriptionRegistry(),
      relayUrl: RELAY_URL,
      authPolicy: {
        canWrite: ({ authenticatedPubkeys, event }) =>
          authenticatedPubkeys.has(event.pubkey)
            ? { ok: true }
            : { ok: false, kind: "auth-required" },
      },
    });

    const opened = await collect(policyRelay.handleConnectionOpen("conn-a"));
    const challenge = opened[0]?.message.type === "AUTH" ? opened[0].message.challenge : "";

    const { sk, pubkey } = freshKey();
    const authEvent = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", RELAY_URL],
          ["challenge", challenge],
        ],
        content: "",
      },
      sk,
    );
    const authOut = await collect(policyRelay.handleClientMessage("conn-a", ["AUTH", authEvent]));
    expect(authOut[0]?.message).toMatchObject({ type: "OK", accepted: true });

    const e = sign({ kind: 1, secretKey: sk });
    expect(e.pubkey).toBe(pubkey); // sanity
    const out = await collect(policyRelay.handleClientMessage("conn-a", ["EVENT", e]));
    expect(out[0]?.message).toMatchObject({ type: "OK", accepted: true });
  });
});
