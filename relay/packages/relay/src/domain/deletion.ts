import type { NostrEvent } from "./validate.ts";

/** NIP-09 deletion request event kind. */
export const KIND_DELETION = 5;

export interface AddressableTarget {
  kind: number;
  pubkey: string;
  dTag: string;
}

export interface DeletionRequest {
  /** Event ids referenced by `e` tags. */
  eventIds: string[];
  /** Addressable coordinates referenced by `a` tags. */
  addressables: AddressableTarget[];
}

const HEX_64 = /^[a-f0-9]{64}$/;

/**
 * Parse a kind-5 deletion request's `e` and `a` tags.
 *
 * Caller is responsible for verifying that `event.kind === KIND_DELETION`
 * and that each target is authored by `event.pubkey` before acting.
 */
export function parseDeletionRequest(event: NostrEvent): DeletionRequest {
  const eventIds: string[] = [];
  const addressables: AddressableTarget[] = [];

  for (const tag of event.tags) {
    if (tag[0] === "e") {
      const id = tag[1];
      if (typeof id === "string" && HEX_64.test(id)) eventIds.push(id);
    } else if (tag[0] === "a") {
      const coord = parseAddressable(tag[1]);
      if (coord) addressables.push(coord);
    }
  }

  return { eventIds, addressables };
}

/**
 * Parse an `a` tag value of the form `<kind>:<pubkey>:<d-identifier>`.
 * Returns null if the string doesn't match the expected shape.
 */
export function parseAddressable(raw: unknown): AddressableTarget | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [kindStr, pubkey, dTag] = parts as [string, string, string];
  const kind = Number.parseInt(kindStr, 10);
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) return null;
  if (!HEX_64.test(pubkey)) return null;
  return { kind, pubkey, dTag };
}
