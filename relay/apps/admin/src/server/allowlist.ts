import { createServerFn } from "@tanstack/react-start";
import { ALLOWLIST_CHANNEL, getSql } from "../lib/db";
import { normalizePubkey } from "../lib/pubkey";
import { requireAdmin } from "./session";

export interface AllowlistEntry {
  /** 64-char lowercase hex pubkey. */
  pubkey: string;
  /** Optional human note (e.g. whose key this is). */
  label: string | null;
  /** Pubkey of the admin who added the entry, if recorded. */
  addedBy: string | null;
  /** Unix seconds the entry was added. */
  addedAt: number;
}

interface Row {
  pubkey: string;
  label: string | null;
  added_by: string | null;
  added_at: string;
}

function toEntry(r: Row): AllowlistEntry {
  return {
    pubkey: r.pubkey,
    label: r.label,
    addedBy: r.added_by,
    // postgres.js returns bigint columns as strings to avoid precision loss.
    addedAt: Number(r.added_at),
  };
}

/** All allowlist entries, newest first. */
export const listAllowlist = createServerFn({ method: "GET" }).handler(
  async (): Promise<AllowlistEntry[]> => {
    await requireAdmin();
    const sql = getSql();
    const rows = await sql<Row[]>`
      SELECT pubkey, label, added_by, added_at
      FROM write_allowlist
      ORDER BY added_at DESC
    `;
    return rows.map(toEntry);
  },
);

/**
 * Add (or relabel) an allowlist entry, then notify the relay to refresh live.
 * Accepts hex or npub; an existing pubkey has its label updated.
 */
export const addAllowlistEntry = createServerFn({ method: "POST" })
  .validator((data: { pubkey: string; label?: string }) => data)
  .handler(async ({ data }): Promise<AllowlistEntry> => {
    const addedBy = await requireAdmin();
    const pubkey = normalizePubkey(data.pubkey);
    const label = data.label?.trim() || null;
    const addedAt = Math.floor(Date.now() / 1000);
    const sql = getSql();
    const [row] = await sql<Row[]>`
      INSERT INTO write_allowlist (pubkey, label, added_by, added_at)
      VALUES (${pubkey}, ${label}, ${addedBy}, ${addedAt})
      ON CONFLICT (pubkey) DO UPDATE SET label = EXCLUDED.label
      RETURNING pubkey, label, added_by, added_at
    `;
    await sql`SELECT pg_notify(${ALLOWLIST_CHANNEL}, '')`;
    return toEntry(row);
  });

/** Remove an allowlist entry, then notify the relay to refresh live. */
export const removeAllowlistEntry = createServerFn({ method: "POST" })
  .validator((data: { pubkey: string }) => data)
  .handler(async ({ data }): Promise<{ pubkey: string }> => {
    await requireAdmin();
    const pubkey = normalizePubkey(data.pubkey);
    const sql = getSql();
    await sql`DELETE FROM write_allowlist WHERE pubkey = ${pubkey}`;
    await sql`SELECT pg_notify(${ALLOWLIST_CHANNEL}, '')`;
    return { pubkey };
  });
