import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, test } from "vitest";
import { LOGIN_KIND, parseAdminPubkeys, verifyLoginEvent } from "./nostr-auth";

const now = 1_700_000_000;

function makeLogin(sk: Uint8Array, createdAt: number, kind: number = LOGIN_KIND) {
  return finalizeEvent({ kind, created_at: createdAt, tags: [], content: "relay admin login" }, sk);
}

describe("verifyLoginEvent", () => {
  test("accepts a fresh event from an admin", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(verifyLoginEvent(makeLogin(sk, now), new Set([pk]), now)).toBe(pk);
  });

  test("rejects a non-admin pubkey", () => {
    const sk = generateSecretKey();
    expect(() => verifyLoginEvent(makeLogin(sk, now), new Set(), now)).toThrow(/admin/i);
  });

  test("rejects a stale event", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(() => verifyLoginEvent(makeLogin(sk, now - 120), new Set([pk]), now)).toThrow(
      /expired/i,
    );
  });

  test("rejects the wrong kind", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(() => verifyLoginEvent(makeLogin(sk, now, 1), new Set([pk]), now)).toThrow(/kind/i);
  });

  test("rejects a tampered signature", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    // JSON round-trip strips nostr-tools' cached `verified` Symbol so the sig
    // is actually re-checked — mirrors how the event arrives over the RPC wire.
    const ev = JSON.parse(JSON.stringify(makeLogin(sk, now)));
    ev.sig = "0".repeat(128);
    expect(() => verifyLoginEvent(ev, new Set([pk]), now)).toThrow(/signature/i);
  });
});

describe("parseAdminPubkeys", () => {
  test("parses a hex key, drops junk", () => {
    const pk = getPublicKey(generateSecretKey());
    const set = parseAdminPubkeys(`${pk}, not-a-key`);
    expect(set.has(pk)).toBe(true);
    expect(set.size).toBe(1);
  });

  test("empty/unset = no admins", () => {
    expect(parseAdminPubkeys(undefined).size).toBe(0);
    expect(parseAdminPubkeys("").size).toBe(0);
  });
});
