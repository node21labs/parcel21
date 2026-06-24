import { describe, expect, test } from "vite-plus/test";
import {
  composeWritePolicies,
  isProtectedEvent,
  protectedEventsPolicy,
  writeAllowlistPolicy,
} from "../src/policies.ts";
import type { NostrEvent } from "../src/domain/validate.ts";

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "c".repeat(128),
    ...overrides,
  };
}

describe("isProtectedEvent", () => {
  test("returns true when a `-` tag is present", () => {
    expect(isProtectedEvent(event({ tags: [["-"]] }))).toBe(true);
  });
  test("returns false when no `-` tag is present", () => {
    expect(isProtectedEvent(event({ tags: [["e", "abc"]] }))).toBe(false);
  });
  test("returns true even when other tags coexist", () => {
    expect(isProtectedEvent(event({ tags: [["e", "abc"], ["-"], ["p", "xyz"]] }))).toBe(true);
  });
});

describe("protectedEventsPolicy", () => {
  const policy = protectedEventsPolicy();

  test("non-protected events pass regardless of auth", () => {
    const e = event({ tags: [] });
    expect(policy({ connId: "c", event: e, authenticatedPubkeys: new Set() })).toEqual({
      ok: true,
    });
  });

  test("protected event from unauthenticated client → auth-required", () => {
    const e = event({ tags: [["-"]] });
    const decision = policy({ connId: "c", event: e, authenticatedPubkeys: new Set() });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.kind).toBe("auth-required");
      expect(decision.message).toMatch(/author/);
    }
  });

  test("protected event from authed client with mismatched pubkey → auth-required", () => {
    const e = event({ pubkey: "b".repeat(64), tags: [["-"]] });
    const decision = policy({
      connId: "c",
      event: e,
      authenticatedPubkeys: new Set(["a".repeat(64)]),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.kind).toBe("auth-required");
  });

  test("protected event from authed author → ok", () => {
    const e = event({ pubkey: "b".repeat(64), tags: [["-"]] });
    expect(
      policy({
        connId: "c",
        event: e,
        authenticatedPubkeys: new Set(["b".repeat(64)]),
      }),
    ).toEqual({ ok: true });
  });
});

describe("writeAllowlistPolicy", () => {
  const ctx = (pubkey: string) => ({
    connId: "c",
    event: event({ pubkey }),
    authenticatedPubkeys: new Set<string>(),
  });

  test("empty allowlist disables the gate (open writes)", () => {
    const policy = writeAllowlistPolicy(new Set());
    expect(policy(ctx("a".repeat(64)))).toEqual({ ok: true });
  });

  test("accepts an event whose pubkey is on the list", () => {
    const team = "b".repeat(64);
    const policy = writeAllowlistPolicy(new Set([team]));
    expect(policy(ctx(team))).toEqual({ ok: true });
  });

  test("rejects an event whose pubkey is not on the list", () => {
    const policy = writeAllowlistPolicy(new Set(["b".repeat(64)]));
    const decision = policy(ctx("e".repeat(64)));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.kind).toBe("restricted");
  });

  test("does not require NIP-42 auth — gates by signature/pubkey alone", () => {
    const team = "b".repeat(64);
    const policy = writeAllowlistPolicy(new Set([team]));
    // authenticatedPubkeys is empty; allowed purely because pubkey is on the list.
    expect(
      policy({ connId: "c", event: event({ pubkey: team }), authenticatedPubkeys: new Set() }),
    ).toEqual({
      ok: true,
    });
  });
});

describe("composeWritePolicies", () => {
  const allow: NonNullable<Parameters<typeof composeWritePolicies>[0]> = () => ({ ok: true });
  const denyAuth: NonNullable<Parameters<typeof composeWritePolicies>[0]> = () => ({
    ok: false,
    kind: "auth-required",
    message: "first",
  });
  const denyRestrict: NonNullable<Parameters<typeof composeWritePolicies>[0]> = () => ({
    ok: false,
    kind: "restricted",
    message: "second",
  });

  const ctx = { connId: "c", event: event(), authenticatedPubkeys: new Set<string>() };

  test("returns ok when all policies allow", () => {
    expect(composeWritePolicies(allow, allow)(ctx)).toEqual({ ok: true });
  });

  test("short-circuits on first denial", () => {
    const decision = composeWritePolicies(denyAuth, denyRestrict)(ctx);
    expect(decision).toEqual({ ok: false, kind: "auth-required", message: "first" });
  });

  test("subsequent policies are skipped after a denial", () => {
    const calls: string[] = [];
    const tracker: NonNullable<Parameters<typeof composeWritePolicies>[0]> = () => {
      calls.push("after-deny");
      return { ok: true };
    };
    composeWritePolicies(denyAuth, tracker)(ctx);
    expect(calls).toEqual([]);
  });

  test("empty composition is permissive", () => {
    expect(composeWritePolicies()(ctx)).toEqual({ ok: true });
  });
});
