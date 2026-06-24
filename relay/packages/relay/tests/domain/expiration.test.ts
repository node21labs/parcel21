import { describe, expect, test } from "vite-plus/test";
import { parseExpiration } from "../../src/domain/expiration.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

function event(tags: string[][]): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: 1,
    tags,
    content: "",
    sig: "c".repeat(128),
  };
}

describe("parseExpiration", () => {
  test("returns 'none' when no expiration tag present", () => {
    expect(parseExpiration(event([]))).toEqual({ kind: "none" });
    expect(parseExpiration(event([["e", "abc"]]))).toEqual({ kind: "none" });
  });

  test("parses a valid integer unix timestamp", () => {
    expect(parseExpiration(event([["expiration", "1700000000"]]))).toEqual({
      kind: "ok",
      expiresAt: 1700000000,
    });
  });

  test("accepts 0", () => {
    expect(parseExpiration(event([["expiration", "0"]]))).toEqual({
      kind: "ok",
      expiresAt: 0,
    });
  });

  test("rejects non-integer strings", () => {
    expect(parseExpiration(event([["expiration", "abc"]]))).toEqual({ kind: "invalid" });
    expect(parseExpiration(event([["expiration", "1.5"]]))).toEqual({ kind: "invalid" });
    expect(parseExpiration(event([["expiration", ""]]))).toEqual({ kind: "invalid" });
  });

  test("rejects negative values", () => {
    expect(parseExpiration(event([["expiration", "-1"]]))).toEqual({ kind: "invalid" });
  });

  test("rejects leading/trailing junk (parseInt-friendly but spec-invalid)", () => {
    expect(parseExpiration(event([["expiration", "100abc"]]))).toEqual({ kind: "invalid" });
    expect(parseExpiration(event([["expiration", " 100 "]]))).toEqual({ kind: "invalid" });
  });

  test("rejects when tag value is missing", () => {
    expect(parseExpiration(event([["expiration"]]))).toEqual({ kind: "invalid" });
  });

  test("uses the first expiration tag when multiple are present", () => {
    expect(
      parseExpiration(
        event([
          ["expiration", "100"],
          ["expiration", "200"],
        ]),
      ),
    ).toEqual({ kind: "ok", expiresAt: 100 });
  });
});
