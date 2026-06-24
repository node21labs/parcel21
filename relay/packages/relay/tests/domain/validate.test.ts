import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  computeEventId,
  serializeEvent,
  validateEvent,
  type NostrEvent,
} from "../../src/domain/validate.ts";

function signed(overrides: Partial<Omit<NostrEvent, "id" | "sig">> = {}) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const template = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "hello nostr",
    ...overrides,
    pubkey,
  };
  return finalizeEvent(template, sk) as NostrEvent;
}

describe("serializeEvent", () => {
  test("produces canonical NIP-01 form with no whitespace", () => {
    const out = serializeEvent({
      pubkey: "a".repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [["e", "b".repeat(64)]],
      content: "hi",
    });
    expect(out).toBe(`[0,"${"a".repeat(64)}",1700000000,1,[["e","${"b".repeat(64)}"]],"hi"]`);
  });

  test("escapes required control characters in content", () => {
    const out = serializeEvent({
      pubkey: "a".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: 'line1\nline2\t"q"\\end',
    });
    expect(out).toContain('"line1\\nline2\\t\\"q\\"\\\\end"');
  });
});

describe("computeEventId", () => {
  test("matches the id produced by nostr-tools finalizeEvent", () => {
    const evt = signed();
    expect(computeEventId(evt)).toBe(evt.id);
  });
});

describe("validateEvent", () => {
  let valid: NostrEvent;

  beforeAll(() => {
    valid = signed();
  });

  test("accepts a properly signed event", () => {
    const result = validateEvent(valid);
    expect(result.ok).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(validateEvent(null).ok).toBe(false);
    expect(validateEvent("string").ok).toBe(false);
    expect(validateEvent(42).ok).toBe(false);
  });

  test("rejects missing or malformed id", () => {
    const r = validateEvent({ ...valid, id: "notahex" });
    expect(r).toEqual({ ok: false, reason: "bad_id" });
  });

  test("rejects uppercase hex id", () => {
    const r = validateEvent({ ...valid, id: valid.id.toUpperCase() });
    expect(r).toEqual({ ok: false, reason: "bad_id" });
  });

  test("rejects malformed pubkey", () => {
    const r = validateEvent({ ...valid, pubkey: "a".repeat(63) });
    expect(r).toEqual({ ok: false, reason: "bad_pubkey" });
  });

  test("rejects malformed sig", () => {
    const r = validateEvent({ ...valid, sig: "f".repeat(127) });
    expect(r).toEqual({ ok: false, reason: "bad_sig" });
  });

  test("rejects non-integer created_at", () => {
    const r = validateEvent({ ...valid, created_at: 1.5 });
    expect(r).toEqual({ ok: false, reason: "bad_created_at" });
  });

  test("rejects negative created_at", () => {
    const r = validateEvent({ ...valid, created_at: -1 });
    expect(r).toEqual({ ok: false, reason: "bad_created_at" });
  });

  test("rejects out-of-range kind", () => {
    expect(validateEvent({ ...valid, kind: -1 })).toEqual({
      ok: false,
      reason: "bad_kind",
    });
    expect(validateEvent({ ...valid, kind: 65536 })).toEqual({
      ok: false,
      reason: "bad_kind",
    });
    expect(validateEvent({ ...valid, kind: 1.5 })).toEqual({
      ok: false,
      reason: "bad_kind",
    });
  });

  test("rejects non-string content", () => {
    const r = validateEvent({ ...valid, content: 123 });
    expect(r).toEqual({ ok: false, reason: "bad_content" });
  });

  test("rejects non-array tags", () => {
    const r = validateEvent({ ...valid, tags: "nope" });
    expect(r).toEqual({ ok: false, reason: "bad_tags" });
  });

  test("rejects tag element that is not an array", () => {
    const r = validateEvent({ ...valid, tags: ["e", "abc"] });
    expect(r).toEqual({ ok: false, reason: "bad_tags" });
  });

  test("rejects tag with non-string value", () => {
    const r = validateEvent({ ...valid, tags: [["e", 123]] });
    expect(r).toEqual({ ok: false, reason: "bad_tags" });
  });

  test("rejects id that does not match the computed hash", () => {
    const tampered = { ...valid, content: `${valid.content} tampered` };
    const r = validateEvent(tampered);
    expect(r).toEqual({ ok: false, reason: "id_mismatch" });
  });

  test("rejects event with a forged signature", () => {
    const other = signed();
    const forged = { ...valid, sig: other.sig };
    const r = validateEvent(forged);
    expect(r).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("accepts event with single-letter indexed tags", () => {
    const evt = signed({ tags: [["e", "b".repeat(64), "wss://relay"]] });
    expect(validateEvent(evt).ok).toBe(true);
  });
});
