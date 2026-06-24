import { useSession } from "@tanstack/react-start/server";
import { getSql } from "../lib/db";
import { parseAdminPubkeys } from "../lib/nostr-auth";

// Server-only: this is the sole importer of `@tanstack/react-start/server`.
// It is referenced exclusively from inside createServerFn handler bodies, so
// the TanStack Start plugin strips it from the client bundle.

interface AdminSession {
  pubkey?: string;
}

// Dev-only fallback so the app runs locally without config. MUST be overridden
// in production via ADMIN_SESSION_SECRET (sealing key; >= 32 chars).
const DEV_SESSION_SECRET = "dev-only-insecure-admin-session-secret-change-me";

function sessionConfig() {
  return {
    password: process.env.ADMIN_SESSION_SECRET ?? DEV_SESSION_SECRET,
    name: "relay_admin",
    maxAge: 60 * 60 * 12, // 12 hours
  };
}

/**
 * The set of admin pubkeys (hex), read from the `admins` table. Seeds the table
 * once from `ADMIN_PUBKEYS` when it is empty (bootstrap) so a fresh deploy isn't
 * locked out; thereafter the table is authoritative and managed in the UI.
 * Empty table + empty env = no admins, which fails closed (nobody can sign in).
 */
export async function getAdminSet(): Promise<Set<string>> {
  const sql = getSql();
  let rows = await sql<{ pubkey: string }[]>`SELECT pubkey FROM admins`;
  if (rows.length === 0) {
    const seed = parseAdminPubkeys(process.env.ADMIN_PUBKEYS);
    if (seed.size > 0) {
      const now = Math.floor(Date.now() / 1000);
      const values = [...seed].map((pubkey) => ({ pubkey, label: "env seed", added_at: now }));
      await sql`INSERT INTO admins ${sql(values)} ON CONFLICT (pubkey) DO NOTHING`;
      rows = await sql<{ pubkey: string }[]>`SELECT pubkey FROM admins`;
    }
  }
  return new Set(rows.map((r) => r.pubkey));
}

/** Open an admin session for a verified pubkey. */
export async function openAdminSession(pubkey: string): Promise<void> {
  const session = await useSession<AdminSession>(sessionConfig());
  await session.update({ pubkey });
}

/**
 * The current signed-in admin pubkey, or null. Re-checks membership on every
 * call so removing an admin takes effect on sessions opened earlier.
 */
export async function currentAdmin(): Promise<string | null> {
  const session = await useSession<AdminSession>(sessionConfig());
  const pubkey = session.data.pubkey;
  if (!pubkey) return null;
  const admins = await getAdminSet();
  return admins.has(pubkey) ? pubkey : null;
}

/** End the current admin session. */
export async function endAdminSession(): Promise<void> {
  const session = await useSession<AdminSession>(sessionConfig());
  await session.clear();
}

/** Guard for protected server functions: returns the admin pubkey or throws. */
export async function requireAdmin(): Promise<string> {
  const pubkey = await currentAdmin();
  if (!pubkey) throw new Error("Unauthorized");
  return pubkey;
}
