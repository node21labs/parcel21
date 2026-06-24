import { createServerFn } from "@tanstack/react-start";
import type { Event } from "nostr-tools/pure";
import { verifyLoginEvent } from "../lib/nostr-auth";
import { currentAdmin, endAdminSession, getAdminSet, openAdminSession } from "./session";

/**
 * Verify a NIP-07-signed login event and, on success, open an admin session.
 * The event proves control of an admin pubkey; the session is a sealed,
 * httpOnly cookie thereafter.
 */
export const login = createServerFn({ method: "POST" })
  .validator((data: { event: Event }) => data)
  .handler(async ({ data }): Promise<{ pubkey: string }> => {
    const admins = await getAdminSet();
    const pubkey = verifyLoginEvent(data.event, admins, Math.floor(Date.now() / 1000));
    await openAdminSession(pubkey);
    return { pubkey };
  });

/** The signed-in admin pubkey, or null. Drives the client login gate. */
export const me = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ pubkey: string } | null> => {
    const pubkey = await currentAdmin();
    return pubkey ? { pubkey } : null;
  },
);

/** End the admin session. */
export const logout = createServerFn({ method: "POST" }).handler(async (): Promise<null> => {
  await endAdminSession();
  return null;
});
