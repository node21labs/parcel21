import { createServerFn } from "@tanstack/react-start";
import { getSql } from "../lib/db";
import { normalizePubkey } from "../lib/pubkey";
import { requireAdmin } from "./session";

/** A stored event, with content truncated to a preview. */
export interface EventRow {
  id: string;
  pubkey: string;
  kind: number;
  createdAt: number;
  /** First ~240 chars of content (full content can be large). */
  content: string;
  expiresAt: number | null;
}

interface RawRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: string;
  content: string;
  expires_at: string | null;
}

const PREVIEW_LEN = 240;

export interface ListEventsInput {
  limit?: number;
  kind?: number;
  /** Author filter — hex or npub. */
  author?: string;
  /** Keyset cursor: rows strictly older than (createdAt, id). */
  cursor?: { createdAt: number; id: string };
}

export interface ListEventsResult {
  events: EventRow[];
  /** Cursor for the next page, or null when there are no more rows. */
  nextCursor: { createdAt: number; id: string } | null;
}

/**
 * Recent events, newest first, keyset-paginated by (created_at, id). Optional
 * kind / author filters. Content is truncated to a preview to keep payloads small.
 */
export const listEvents = createServerFn({ method: "GET" })
  .validator((data: ListEventsInput) => data)
  .handler(async ({ data }): Promise<ListEventsResult> => {
    await requireAdmin();
    const limit = Math.min(Math.max(data.limit ?? 50, 1), 200);
    const sql = getSql();

    let q = sql`
      SELECT id, pubkey, kind, created_at,
             substring(content from 1 for ${PREVIEW_LEN}) AS content,
             expires_at
      FROM events
      WHERE true`;
    if (data.kind !== undefined) q = sql`${q} AND kind = ${data.kind}`;
    if (data.author) q = sql`${q} AND pubkey = ${normalizePubkey(data.author)}`;
    if (data.cursor) {
      const { createdAt, id } = data.cursor;
      q = sql`${q} AND (created_at < ${createdAt} OR (created_at = ${createdAt} AND id < ${id}))`;
    }
    // Fetch one extra row to know whether another page exists.
    q = sql`${q} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;

    const rows = (await q) as unknown as RawRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(
      (r): EventRow => ({
        id: r.id,
        pubkey: r.pubkey,
        kind: r.kind,
        createdAt: Number(r.created_at),
        content: r.content ?? "",
        expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      }),
    );
    const last = page.at(-1);
    return {
      events: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  });
