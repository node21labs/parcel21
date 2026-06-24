import postgres from "postgres";

// Server-only. Imported solely from server-function handlers, so the TanStack
// Start plugin strips it from the client bundle.

let sql: ReturnType<typeof postgres> | null = null;

/**
 * Lazily-created postgres.js client for the relay's database — the same DB the
 * relay reads its `write_allowlist` table from. A module-level singleton so the
 * connection pool is reused across server-function invocations.
 *
 * `prepare: false` mirrors the relay (works against pooled Postgres too).
 */
export function getSql(): ReturnType<typeof postgres> {
  if (!sql) {
    const url = process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:5432/relay";
    sql = postgres(url, { prepare: false });
  }
  return sql;
}

/** Postgres channel the relay LISTENs on; fire after mutating the allowlist. */
export const ALLOWLIST_CHANNEL = "write_allowlist_changed";
