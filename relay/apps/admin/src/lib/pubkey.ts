import { nip19 } from "nostr-tools";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Normalize a Nostr public key to 64-char lowercase hex. Accepts either raw
 * hex or a bech32 `npub1…`. Throws on anything else.
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") throw new Error("Not an npub");
    return decoded.data;
  }
  const lower = trimmed.toLowerCase();
  if (!HEX_64.test(lower)) throw new Error("Pubkey must be 64-char hex or an npub");
  return lower;
}

/** Encode a 64-char hex pubkey as a bech32 `npub1…` for display. */
export function toNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

/** A short, copy-friendly form of an npub: `npub1abcd…wxyz`. */
export function shortNpub(hex: string): string {
  const npub = toNpub(hex);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}
