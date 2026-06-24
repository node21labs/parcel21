import type { Logger } from "@relay/core";
import { type DB, type DbClient, writeAllowlist } from "@relay/db";

/** Postgres channel the admin UI notifies after mutating the allowlist. */
export const ALLOWLIST_CHANNEL = "write_allowlist_changed";

export interface AllowlistSource {
  /** Current set of allowed author pubkeys (lowercase hex). Read on every write. */
  current(): ReadonlySet<string>;
  /** Resolves once the initial load (and one-time seed) completes. */
  ready: Promise<void>;
  /** Stop listening + polling and release resources. */
  close(): Promise<void>;
}

export interface AllowlistSourceOptions {
  db: DB;
  /** Dedicated postgres.js connection used for LISTEN. */
  client: DbClient;
  logger: Logger;
  /**
   * Pubkeys from `WRITE_ALLOWLIST_PUBKEYS`. Inserted into the table only when
   * it is empty (one-time bootstrap), so env-configured relays keep their gate
   * after switching to the DB-backed source. After that the table is authoritative.
   */
  seed?: ReadonlySet<string>;
  /** Poll fallback interval (ms) in case a NOTIFY is missed. Default 30s; 0 disables. */
  pollMs?: number;
}

/**
 * Live, DB-backed write allowlist. The relay reads `current()` on every write;
 * the admin UI mutates the `write_allowlist` table and fires
 * `NOTIFY write_allowlist_changed`, which triggers an immediate refresh. A
 * periodic poll covers the rare case of a dropped notification (listener
 * reconnect). Refresh failures keep the last-known set rather than opening or
 * closing the gate unexpectedly.
 */
export function createAllowlistSource(opts: AllowlistSourceOptions): AllowlistSource {
  const { db, client } = opts;
  const log = opts.logger.child({ component: "allowlist" });
  let set: ReadonlySet<string> = new Set(opts.seed ?? []);
  let closed = false;

  async function load(): Promise<Set<string>> {
    const rows = await db.select({ pubkey: writeAllowlist.pubkey }).from(writeAllowlist);
    return new Set(rows.map((r) => r.pubkey));
  }

  async function refresh(): Promise<void> {
    try {
      set = await load();
    } catch (err) {
      log.error({ err }, "allowlist refresh failed; keeping last-known set");
    }
  }

  async function init(): Promise<void> {
    const seed = opts.seed;
    if (seed && seed.size > 0) {
      const existing = await load();
      if (existing.size === 0) {
        const now = Math.floor(Date.now() / 1000);
        await db
          .insert(writeAllowlist)
          .values([...seed].map((pubkey) => ({ pubkey, label: "env seed", addedAt: now })))
          .onConflictDoNothing();
        log.info({ seeded: seed.size }, "seeded write allowlist from WRITE_ALLOWLIST_PUBKEYS");
      }
    }
    await refresh();
    log.info({ allowlistSize: set.size }, "write allowlist loaded from db");
  }

  const ready = init().catch((err) => {
    log.error({ err }, "allowlist init failed; using seed set");
  });

  // Live updates via LISTEN/NOTIFY.
  let unlisten: (() => Promise<void>) | null = null;
  client
    .listen(ALLOWLIST_CHANNEL, () => void refresh())
    .then((sub) => {
      unlisten = () => sub.unlisten();
      if (closed) void sub.unlisten();
    })
    .catch((err) => log.error({ err }, "allowlist LISTEN failed; relying on poll"));

  // Poll fallback.
  const pollMs = opts.pollMs ?? 30_000;
  const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : null;
  timer?.unref?.();

  return {
    current: () => set,
    ready: ready.then(() => undefined),
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      if (unlisten) await unlisten().catch(() => {});
    },
  };
}
