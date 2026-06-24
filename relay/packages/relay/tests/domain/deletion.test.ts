import { describe, expect, test } from "vite-plus/test";
import {
  KIND_DELETION,
  parseAddressable,
  parseDeletionRequest,
} from "../../src/domain/deletion.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

function event(tags: string[][]): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: KIND_DELETION,
    tags,
    content: "",
    sig: "c".repeat(128),
  };
}

describe("KIND_DELETION", () => {
  test("equals 5 per NIP-09", () => {
    expect(KIND_DELETION).toBe(5);
  });
});

describe("parseAddressable", () => {
  test("parses a well-formed coordinate", () => {
    const c = parseAddressable(`30023:${"b".repeat(64)}:my-article`);
    expect(c).toEqual({ kind: 30023, pubkey: "b".repeat(64), dTag: "my-article" });
  });

  test("accepts replaceable form with empty d-tag", () => {
    const c = parseAddressable(`0:${"b".repeat(64)}:`);
    expect(c).toEqual({ kind: 0, pubkey: "b".repeat(64), dTag: "" });
  });

  test("rejects malformed pubkey", () => {
    expect(parseAddressable(`1:short:x`)).toBeNull();
    expect(parseAddressable(`1:${"B".repeat(64)}:x`)).toBeNull();
  });

  test("rejects out-of-range kind", () => {
    expect(parseAddressable(`-1:${"b".repeat(64)}:x`)).toBeNull();
    expect(parseAddressable(`70000:${"b".repeat(64)}:x`)).toBeNull();
  });

  test("rejects when fewer than 3 parts", () => {
    expect(parseAddressable(`1:${"b".repeat(64)}`)).toBeNull();
    expect(parseAddressable("not-a-coord")).toBeNull();
  });

  test("rejects non-string input", () => {
    expect(parseAddressable(42)).toBeNull();
    expect(parseAddressable(null)).toBeNull();
    expect(parseAddressable(undefined)).toBeNull();
  });
});

describe("parseDeletionRequest", () => {
  test("empty tags → empty request", () => {
    const r = parseDeletionRequest(event([]));
    expect(r).toEqual({ eventIds: [], addressables: [] });
  });

  test("collects e-tag event ids", () => {
    const r = parseDeletionRequest(
      event([
        ["e", "a".repeat(64)],
        ["e", "b".repeat(64), "wss://relay"],
      ]),
    );
    expect(r.eventIds).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  test("ignores malformed e-tag values", () => {
    const r = parseDeletionRequest(event([["e", "not-hex"], ["e", "A".repeat(64)], ["e"]]));
    expect(r.eventIds).toEqual([]);
  });

  test("collects a-tag coordinates", () => {
    const r = parseDeletionRequest(
      event([
        ["a", `30023:${"b".repeat(64)}:article`],
        ["a", `0:${"c".repeat(64)}:`],
      ]),
    );
    expect(r.addressables).toHaveLength(2);
    expect(r.addressables[0]?.kind).toBe(30023);
    expect(r.addressables[1]?.dTag).toBe("");
  });

  test("ignores malformed a-tag values", () => {
    const r = parseDeletionRequest(event([["a", "garbage"], ["a"]]));
    expect(r.addressables).toEqual([]);
  });

  test("ignores non-e/a tags (k, p, etc.)", () => {
    const r = parseDeletionRequest(
      event([
        ["k", "1"],
        ["p", "x".repeat(64)],
        ["e", "a".repeat(64)],
      ]),
    );
    expect(r.eventIds).toEqual(["a".repeat(64)]);
    expect(r.addressables).toEqual([]);
  });
});
