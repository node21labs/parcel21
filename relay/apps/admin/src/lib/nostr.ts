import type { Event } from "nostr-tools/pure";
import { LOGIN_KIND } from "./nostr-auth";

/** Minimal NIP-07 signer surface exposed by browser extensions. */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<Event>;
}

declare global {
  interface Window {
    nostr?: NostrSigner;
  }
}

/**
 * Build and sign an admin login event via the browser's NIP-07 extension.
 * Client-only (touches `window.nostr`). The signed event is sent to the
 * `login` server function, which verifies it.
 */
export async function requestLoginEvent(): Promise<Event> {
  const signer = window.nostr;
  if (!signer) {
    throw new Error("No Nostr extension found. Install a NIP-07 signer (Alby, nos2x, …).");
  }
  return signer.signEvent({
    kind: LOGIN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", window.location.origin],
      ["method", "POST"],
    ],
    content: "relay admin login",
  });
}
