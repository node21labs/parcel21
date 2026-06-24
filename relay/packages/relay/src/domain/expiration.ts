import type { NostrEvent } from "./validate.ts";

/**
 * Parse the NIP-40 `expiration` tag. Returns the unix timestamp, or null if
 * the event has no `expiration` tag.
 *
 * Returns `{ invalid: true }` when the tag is present but malformed — the
 * caller should reject the event in that case.
 */
export type ExpirationResult =
  | { kind: "none" }
  | { kind: "ok"; expiresAt: number }
  | { kind: "invalid" };

export function parseExpiration(event: NostrEvent): ExpirationResult {
  for (const tag of event.tags) {
    if (tag[0] !== "expiration") continue;
    const raw = tag[1];
    if (typeof raw !== "string") return { kind: "invalid" };
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) return { kind: "invalid" };
    if (String(n) !== raw) return { kind: "invalid" };
    return { kind: "ok", expiresAt: n };
  }
  return { kind: "none" };
}
