import { type Event, verifyEvent } from "nostr-tools/pure";
import { normalizePubkey } from "./pubkey";

/** NIP-98 HTTP Auth event kind — reused as the admin login proof. */
export const LOGIN_KIND = 27235;
/** How fresh a login event must be (seconds) — limits replay. */
export const LOGIN_MAX_AGE_SEC = 60;

/**
 * Parse `ADMIN_PUBKEYS` (comma/space-separated hex or npub) into a set of
 * 64-char hex pubkeys. Invalid entries are dropped. Empty/unset = no admins,
 * which fails closed (nobody can sign in).
 */
export function parseAdminPubkeys(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(/[,\s]+/)) {
    if (!part) continue;
    try {
      out.add(normalizePubkey(part));
    } catch {
      // skip malformed entries
    }
  }
  return out;
}

/**
 * Validate a NIP-07-signed login event and return the author pubkey. Throws a
 * user-facing error on any failure. Pure (no I/O) so it can be unit-tested:
 * checks kind, freshness, signature, and membership in the admin set.
 */
export function verifyLoginEvent(
  event: Event,
  admins: ReadonlySet<string>,
  nowSec: number,
): string {
  if (event.kind !== LOGIN_KIND) throw new Error("Unexpected login event kind");
  if (Math.abs(nowSec - event.created_at) > LOGIN_MAX_AGE_SEC) {
    throw new Error("Login event expired — please try again");
  }
  if (!verifyEvent(event)) throw new Error("Invalid signature");
  if (!admins.has(event.pubkey)) throw new Error("Not an authorized admin");
  return event.pubkey;
}
