import { beforeEach, describe, expect, test } from "vite-plus/test";
import { SubscriptionRegistry } from "../../src/domain/subscription.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "",
    sig: "c".repeat(128),
    ...overrides,
  };
}

describe("SubscriptionRegistry.add", () => {
  let reg: SubscriptionRegistry;
  beforeEach(() => {
    reg = new SubscriptionRegistry();
  });

  test("records a subscription and returns true", () => {
    expect(reg.add("conn-a", "sub1", [{ kinds: [1] }])).toBe(true);
    expect(reg.has("conn-a", "sub1")).toBe(true);
    expect(reg.size()).toBe(1);
  });

  test("replaces the previous filters when the same (connId, subId) is added again", () => {
    reg.add("conn-a", "sub1", [{ kinds: [1] }]);
    reg.add("conn-a", "sub1", [{ kinds: [7] }]);
    expect(reg.get("conn-a", "sub1")).toEqual([{ kinds: [7] }]);
    expect(reg.size()).toBe(1);
  });

  test("same subId on different connections do not interfere (per-connection isolation)", () => {
    reg.add("conn-a", "sub1", [{ kinds: [1] }]);
    reg.add("conn-b", "sub1", [{ kinds: [7] }]);
    expect(reg.get("conn-a", "sub1")).toEqual([{ kinds: [1] }]);
    expect(reg.get("conn-b", "sub1")).toEqual([{ kinds: [7] }]);
    expect(reg.size()).toBe(2);
    expect(reg.connectionCount()).toBe(2);
  });
});

describe("SubscriptionRegistry: maxPerConnection", () => {
  test("returns false when a new sub id would exceed the cap", () => {
    const reg = new SubscriptionRegistry({ maxPerConnection: 2 });
    expect(reg.add("conn-a", "s1", [])).toBe(true);
    expect(reg.add("conn-a", "s2", [])).toBe(true);
    expect(reg.add("conn-a", "s3", [])).toBe(false);
    expect(reg.has("conn-a", "s3")).toBe(false);
  });

  test("replacing an existing sub id is allowed even at the cap", () => {
    const reg = new SubscriptionRegistry({ maxPerConnection: 2 });
    reg.add("conn-a", "s1", [{ kinds: [1] }]);
    reg.add("conn-a", "s2", [{ kinds: [2] }]);
    expect(reg.add("conn-a", "s2", [{ kinds: [7] }])).toBe(true);
    expect(reg.get("conn-a", "s2")).toEqual([{ kinds: [7] }]);
  });

  test("cap is per-connection, not global", () => {
    const reg = new SubscriptionRegistry({ maxPerConnection: 1 });
    expect(reg.add("conn-a", "s1", [])).toBe(true);
    expect(reg.add("conn-b", "s1", [])).toBe(true);
  });
});

describe("SubscriptionRegistry.remove", () => {
  let reg: SubscriptionRegistry;
  beforeEach(() => {
    reg = new SubscriptionRegistry();
  });

  test("returns true when a subscription is removed", () => {
    reg.add("conn-a", "sub1", []);
    expect(reg.remove("conn-a", "sub1")).toBe(true);
    expect(reg.has("conn-a", "sub1")).toBe(false);
  });

  test("returns false when the subscription does not exist", () => {
    expect(reg.remove("conn-a", "missing")).toBe(false);
  });

  test("returns false when the connection does not exist", () => {
    expect(reg.remove("ghost", "sub1")).toBe(false);
  });

  test("cleans up the connection entry when its last subscription is removed", () => {
    reg.add("conn-a", "sub1", []);
    reg.remove("conn-a", "sub1");
    expect(reg.connectionCount()).toBe(0);
  });

  test("does not affect other connections", () => {
    reg.add("conn-a", "sub1", []);
    reg.add("conn-b", "sub1", []);
    reg.remove("conn-a", "sub1");
    expect(reg.has("conn-b", "sub1")).toBe(true);
  });
});

describe("SubscriptionRegistry.removeAll", () => {
  let reg: SubscriptionRegistry;
  beforeEach(() => {
    reg = new SubscriptionRegistry();
  });

  test("removes every subscription for the connection and returns the count", () => {
    reg.add("conn-a", "sub1", []);
    reg.add("conn-a", "sub2", []);
    reg.add("conn-b", "sub1", []);
    expect(reg.removeAll("conn-a")).toBe(2);
    expect(reg.has("conn-a", "sub1")).toBe(false);
    expect(reg.has("conn-a", "sub2")).toBe(false);
    expect(reg.has("conn-b", "sub1")).toBe(true);
    expect(reg.size()).toBe(1);
  });

  test("returns 0 when the connection has no subscriptions", () => {
    expect(reg.removeAll("ghost")).toBe(0);
  });
});

describe("SubscriptionRegistry.matching", () => {
  let reg: SubscriptionRegistry;
  beforeEach(() => {
    reg = new SubscriptionRegistry();
  });

  test("yields nothing when the registry is empty", () => {
    expect([...reg.matching(event())]).toEqual([]);
  });

  test("yields every subscription whose filters match the event", () => {
    reg.add("conn-a", "sub1", [{ kinds: [1] }]);
    reg.add("conn-a", "sub2", [{ kinds: [7] }]);
    reg.add("conn-b", "sub1", [{ kinds: [1, 2] }]);

    const matches = [...reg.matching(event({ kind: 1 }))];
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => `${m.connId}/${m.subId}`).sort()).toEqual([
      "conn-a/sub1",
      "conn-b/sub1",
    ]);
  });

  test("treats a subscription with multiple filters as OR", () => {
    reg.add("conn-a", "sub1", [{ kinds: [0] }, { kinds: [1] }]);
    expect([...reg.matching(event({ kind: 1 }))]).toHaveLength(1);
    expect([...reg.matching(event({ kind: 2 }))]).toHaveLength(0);
  });

  test("does not yield a subscription with zero filters", () => {
    reg.add("conn-a", "sub1", []);
    expect([...reg.matching(event())]).toEqual([]);
  });

  test("includes the filters on the yielded subscription", () => {
    const filters = [{ kinds: [1] }];
    reg.add("conn-a", "sub1", filters);
    const [match] = [...reg.matching(event({ kind: 1 }))];
    expect(match?.filters).toBe(filters);
  });
});
