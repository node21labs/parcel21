import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, test } from "vite-plus/test";
import {
  AUTH_MAX_AGE_SECONDS,
  ConnectionAuth,
  KIND_AUTH,
  newChallenge,
  sameHost,
  validateAuthEvent,
} from "../../src/domain/auth.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

const RELAY = "wss://relay.example.com/";

function signed({
  kind = KIND_AUTH,
  challenge = "chal-123",
  relay = RELAY,
  tags,
  created_at = Math.floor(Date.now() / 1000),
}: {
  kind?: number;
  challenge?: string;
  relay?: string;
  tags?: string[][];
  created_at?: number;
} = {}): NostrEvent {
  const finalTags = tags ?? [
    ["relay", relay],
    ["challenge", challenge],
  ];
  const sk = generateSecretKey();
  return finalizeEvent({ kind, created_at, tags: finalTags, content: "" }, sk) as NostrEvent;
}

describe("KIND_AUTH", () => {
  test("equals 22242", () => {
    expect(KIND_AUTH).toBe(22242);
  });
});

describe("newChallenge", () => {
  test("produces unique values", () => {
    const a = newChallenge();
    const b = newChallenge();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("sameHost", () => {
  test("compares hostnames case-insensitively", () => {
    expect(sameHost("wss://Relay.Example.com", "wss://relay.example.com")).toBe(true);
  });
  test("accepts http/https/ws/wss variants", () => {
    expect(sameHost("https://relay.example.com/", "wss://relay.example.com")).toBe(true);
  });
  test("different hosts → false", () => {
    expect(sameHost("wss://a.example.com", "wss://b.example.com")).toBe(false);
  });
  test("accepts bare hostnames", () => {
    expect(sameHost("relay.example.com", "wss://relay.example.com/")).toBe(true);
  });
});

describe("validateAuthEvent", () => {
  const now = Math.floor(Date.now() / 1000);

  test("accepts a fresh, well-formed AUTH event", () => {
    const event = signed({ challenge: "chal-123", created_at: now });
    const result = validateAuthEvent(event, {
      challenge: "chal-123",
      relayUrl: RELAY,
      now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pubkey).toBe(event.pubkey);
  });

  test("rejects wrong kind", () => {
    const event = signed({ kind: 1, created_at: now });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "wrong_kind" });
  });

  test("rejects stale created_at (past the allowed window)", () => {
    const event = signed({ created_at: now - (AUTH_MAX_AGE_SECONDS + 1) });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "stale_created_at" });
  });

  test("rejects future created_at past the allowed window", () => {
    const event = signed({ created_at: now + (AUTH_MAX_AGE_SECONDS + 1) });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "stale_created_at" });
  });

  test("rejects when challenge tag is missing", () => {
    const event = signed({ tags: [["relay", RELAY]], created_at: now });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "missing_challenge" });
  });

  test("rejects challenge mismatch", () => {
    const event = signed({ challenge: "wrong", created_at: now });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "challenge_mismatch" });
  });

  test("rejects when relay tag is missing", () => {
    const event = signed({ tags: [["challenge", "chal-123"]], created_at: now });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "missing_relay" });
  });

  test("rejects relay URL mismatch", () => {
    const event = signed({ relay: "wss://evil.example.com", created_at: now });
    const r = validateAuthEvent(event, { challenge: "chal-123", relayUrl: RELAY, now });
    expect(r).toEqual({ ok: false, reason: "relay_mismatch" });
  });
});

describe("ConnectionAuth", () => {
  test("challengeFor returns a stable challenge across calls", () => {
    const auth = new ConnectionAuth();
    const a = auth.challengeFor("conn-a");
    const b = auth.challengeFor("conn-a");
    expect(a).toBe(b);
  });

  test("different connections get different challenges", () => {
    const auth = new ConnectionAuth();
    expect(auth.challengeFor("conn-a")).not.toBe(auth.challengeFor("conn-b"));
  });

  test("rotateChallenge issues a new challenge and preserves pubkeys", () => {
    const auth = new ConnectionAuth();
    const original = auth.challengeFor("conn-a");
    auth.authenticate("conn-a", "pk");
    const rotated = auth.rotateChallenge("conn-a");
    expect(rotated).not.toBe(original);
    expect(auth.isAuthenticated("conn-a", "pk")).toBe(true);
  });

  test("authenticate marks a pubkey as authed", () => {
    const auth = new ConnectionAuth();
    auth.authenticate("conn-a", "pk1");
    auth.authenticate("conn-a", "pk2");
    expect(auth.isAuthenticated("conn-a", "pk1")).toBe(true);
    expect(auth.isAuthenticated("conn-a", "pk2")).toBe(true);
    expect([...auth.authenticatedPubkeys("conn-a")].sort()).toEqual(["pk1", "pk2"]);
  });

  test("forget clears a connection's state", () => {
    const auth = new ConnectionAuth();
    auth.authenticate("conn-a", "pk");
    auth.forget("conn-a");
    expect(auth.isAuthenticated("conn-a", "pk")).toBe(false);
  });
});
