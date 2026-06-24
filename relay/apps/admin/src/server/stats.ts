import { createServerFn } from "@tanstack/react-start";
import { getSql } from "../lib/db";
import { requireAdmin } from "./session";

export interface RelayStats {
  totalEvents: number;
  uniqueAuthors: number;
  last24h: number;
  last7d: number;
  deletedEvents: number;
  expiringEvents: number;
  /** Top event kinds by count. */
  byKind: { kind: number; count: number }[];
}

const n = (v: unknown): number => Number((v as { count?: unknown }).count ?? 0);

/**
 * Aggregate relay stats from the events tables. These are full-table aggregates
 * (count / distinct / group-by); fine at typical relay sizes, run concurrently.
 */
export const getStats = createServerFn({ method: "GET" }).handler(async (): Promise<RelayStats> => {
  await requireAdmin();
  const sql = getSql();
  const nowSec = Math.floor(Date.now() / 1000);
  const dayAgo = nowSec - 86_400;
  const weekAgo = nowSec - 7 * 86_400;

  const [total, authors, day, week, deleted, expiring, kinds] = await Promise.all([
    sql`SELECT count(*) AS count FROM events`,
    sql`SELECT count(DISTINCT pubkey) AS count FROM events`,
    sql`SELECT count(*) AS count FROM events WHERE created_at > ${dayAgo}`,
    sql`SELECT count(*) AS count FROM events WHERE created_at > ${weekAgo}`,
    sql`SELECT count(*) AS count FROM deleted_events`,
    sql`SELECT count(*) AS count FROM events WHERE expires_at IS NOT NULL`,
    sql`SELECT kind, count(*) AS count FROM events GROUP BY kind ORDER BY count(*) DESC LIMIT 12`,
  ]);

  return {
    totalEvents: n(total[0]),
    uniqueAuthors: n(authors[0]),
    last24h: n(day[0]),
    last7d: n(week[0]),
    deletedEvents: n(deleted[0]),
    expiringEvents: n(expiring[0]),
    byKind: (kinds as unknown as { kind: number; count: string }[]).map((r) => ({
      kind: r.kind,
      count: Number(r.count),
    })),
  };
});
