import { randomBytes } from "node:crypto";
import type { NostrEvent } from "./validate.ts";

/** NIP-42 authentication event kind. */
export const KIND_AUTH = 22242;

/** How far from "now" a NIP-42 AUTH event's `created_at` may drift. */
export const AUTH_MAX_AGE_SECONDS = 600; // 10 minutes (spec suggestion)

export type AuthValidation =
  | { ok: true; pubkey: string }
  | { ok: false; reason: AuthInvalidReason };

export type AuthInvalidReason =
  | "wrong_kind"
  | "stale_created_at"
  | "missing_challenge"
  | "challenge_mismatch"
  | "missing_relay"
  | "relay_mismatch";

export interface ValidateAuthOptions {
  /** The challenge we issued for this connection. */
  challenge: string;
  /** Our public URL (e.g. `wss://relay.example.com`). Host is compared case-insensitively. */
  relayUrl: string;
  /** Current time in unix seconds — overridable for tests. */
  now: number;
}

/**
 * NIP-42 AUTH event semantic validation. The caller should have already run
 * `validateEvent` to confirm the schnorr signature and id; this only checks
 * the kind-22242 specific rules.
 */
export function validateAuthEvent(event: NostrEvent, options: ValidateAuthOptions): AuthValidation {
  if (event.kind !== KIND_AUTH) {
    return { ok: false, reason: "wrong_kind" };
  }

  if (Math.abs(options.now - event.created_at) > AUTH_MAX_AGE_SECONDS) {
    return { ok: false, reason: "stale_created_at" };
  }

  const challengeTag = event.tags.find((t) => t[0] === "challenge");
  if (!challengeTag || typeof challengeTag[1] !== "string") {
    return { ok: false, reason: "missing_challenge" };
  }
  if (challengeTag[1] !== options.challenge) {
    return { ok: false, reason: "challenge_mismatch" };
  }

  const relayTag = event.tags.find((t) => t[0] === "relay");
  if (!relayTag || typeof relayTag[1] !== "string") {
    return { ok: false, reason: "missing_relay" };
  }
  if (!sameHost(relayTag[1], options.relayUrl)) {
    return { ok: false, reason: "relay_mismatch" };
  }

  return { ok: true, pubkey: event.pubkey };
}

/**
 * Case-insensitive host comparison. Accepts `wss://`, `ws://`, `https://`,
 * `http://`, or bare host. Per NIP-42 hint: "checking if the domain name is
 * correct should be enough."
 */
export function sameHost(a: string, b: string): boolean {
  return extractHost(a) === extractHost(b);
}

function extractHost(raw: string): string {
  const trimmed = raw.trim();
  try {
    // `.hostname` excludes the port — per NIP-42 "just checking if the domain
    // name is correct should be enough", and this avoids 443-vs-default and
    // other port-equivalence mismatches.
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    // Bare hosts: strip trailing slash, drop any :port, lowercase.
    return trimmed.toLowerCase().replace(/\/$/, "").replace(/:\d+$/, "");
  }
}

/** Generate a fresh challenge string (24 bytes base64url, ~32 chars). */
export function newChallenge(): string {
  return randomBytes(24).toString("base64url");
}

/** Per-connection authentication registry. */
export class ConnectionAuth {
  private readonly state = new Map<string, { challenge: string; pubkeys: Set<string> }>();

  /**
   * Return the current challenge for this connection, issuing a fresh one if
   * none exists. Existing authenticated pubkeys are retained on re-issue.
   */
  challengeFor(connId: string): string {
    let entry = this.state.get(connId);
    if (!entry) {
      entry = { challenge: newChallenge(), pubkeys: new Set() };
      this.state.set(connId, entry);
    }
    return entry.challenge;
  }

  /**
   * Roll a fresh challenge for a connection (invalidates the old one).
   * Called after failed auth attempts so a single captured challenge can't
   * be ground at indefinitely. Authenticated pubkeys are preserved.
   */
  rotateChallenge(connId: string): string {
    const entry = this.state.get(connId);
    const challenge = newChallenge();
    if (entry) entry.challenge = challenge;
    else this.state.set(connId, { challenge, pubkeys: new Set() });
    return challenge;
  }

  /** Record that a connection has proved possession of `pubkey`. */
  authenticate(connId: string, pubkey: string): void {
    let entry = this.state.get(connId);
    if (!entry) {
      entry = { challenge: newChallenge(), pubkeys: new Set() };
      this.state.set(connId, entry);
    }
    entry.pubkeys.add(pubkey);
  }

  isAuthenticated(connId: string, pubkey: string): boolean {
    return this.state.get(connId)?.pubkeys.has(pubkey) ?? false;
  }

  /**
   * Returns the set of authenticated pubkeys. For unknown connections a
   * fresh empty set is returned per call — no shared sentinel the caller
   * could accidentally mutate.
   */
  authenticatedPubkeys(connId: string): ReadonlySet<string> {
    return this.state.get(connId)?.pubkeys ?? new Set<string>();
  }

  forget(connId: string): void {
    this.state.delete(connId);
  }
}
