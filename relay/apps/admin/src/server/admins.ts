import { createServerFn } from "@tanstack/react-start";
import { getSql } from "../lib/db";
import { normalizePubkey } from "../lib/pubkey";
import { requireAdmin } from "./session";

export interface AdminEntry {
  /** 64-char lowercase hex pubkey. */
  pubkey: string;
  /** Optional human note. */
  label: string | null;
  /** Pubkey of the admin who added this one, if recorded. */
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

function toEntry(r: Row): AdminEntry {
  return {
    pubkey: r.pubkey,
    label: r.label,
    addedBy: r.added_by,
    // postgres.js returns bigint columns as strings to avoid precision loss.
    addedAt: Number(r.added_at),
  };
}

/** All admins, newest first. */
export const listAdmins = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminEntry[]> => {
    await requireAdmin();
    const sql = getSql();
    const rows = await sql<Row[]>`
      SELECT pubkey, label, added_by, added_at
      FROM admins
      ORDER BY added_at DESC
    `;
    return rows.map(toEntry);
  },
);

/** Add (or relabel) an admin. Accepts hex or npub. */
export const addAdmin = createServerFn({ method: "POST" })
  .validator((data: { pubkey: string; label?: string }) => data)
  .handler(async ({ data }): Promise<AdminEntry> => {
    const addedBy = await requireAdmin();
    const pubkey = normalizePubkey(data.pubkey);
    const label = data.label?.trim() || null;
    const addedAt = Math.floor(Date.now() / 1000);
    const sql = getSql();
    const [row] = await sql<Row[]>`
      INSERT INTO admins (pubkey, label, added_by, added_at)
      VALUES (${pubkey}, ${label}, ${addedBy}, ${addedAt})
      ON CONFLICT (pubkey) DO UPDATE SET label = EXCLUDED.label
      RETURNING pubkey, label, added_by, added_at
    `;
    return toEntry(row);
  });

/** Remove an admin. Refuses to remove the last one (lockout guard). */
export const removeAdmin = createServerFn({ method: "POST" })
  .validator((data: { pubkey: string }) => data)
  .handler(async ({ data }): Promise<{ pubkey: string }> => {
    await requireAdmin();
    const pubkey = normalizePubkey(data.pubkey);
    const sql = getSql();
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM admins`;
    if (count <= 1) throw new Error("Can't remove the last admin");
    await sql`DELETE FROM admins WHERE pubkey = ${pubkey}`;
    return { pubkey };
  });
