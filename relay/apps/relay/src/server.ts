import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  type AuthPolicy,
  composeWritePolicies,
  createRelay,
  EventStore,
  kindAllowlistPolicy,
  type Logger,
  type Metrics,
  nullMetrics,
  protectedEventsPolicy,
  RateLimiter,
  serializeRelayMessage,
  SubscriptionRegistry,
  writeAllowlistPolicy,
  type Relay,
} from "@relay/core";
import { createDb } from "@relay/db";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { type AllowlistSource, createAllowlistSource } from "./allowlist.ts";
import { getRelayInfo } from "./info.ts";
import { createEmfMetrics, type EmfMetrics } from "./metrics.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export interface RateLimitOptions {
  /** Max WebSocket payload bytes; frames larger than this are rejected by the transport. */
  maxMessageBytes?: number;
  /** Max concurrent connections from a single remote IP. */
  maxConnectionsPerIp?: number;
  /** Max concurrent subscriptions per connection. */
  maxSubsPerConn?: number;
  /** Sustained events-per-second per connection (token refill rate). */
  eventRatePerSecond?: number;
  /** Max burst of events a connection can send in a tight window. */
  eventRateBurst?: number;
}

export interface SweeperOptions {
  /**
   * Interval (ms) between calls to `EventStore.sweepExpired`. Default 60_000.
   * Set to 0 to disable.
   */
  expiredSweepMs?: number;
  /**
   * Interval (ms) between calls to `EventStore.pruneTombstones`. Default
   * 3_600_000 (1 hour). Ignored unless `tombstoneTtlSeconds` is set.
   */
  tombstonePruneMs?: number;
  /**
   * Tombstones older than this many seconds are deleted. Leaving this
   * undefined (the default) disables tombstone pruning entirely — tombstones
   * are kept forever.
   */
  tombstoneTtlSeconds?: number;
}

export interface StartOptions extends RateLimitOptions, SweeperOptions {
  port?: number;
  databaseUrl?: string;
  /**
   * Interval (ms) between server-initiated WebSocket pings used to keep
   * connections from being reaped by idle-sensitive proxies (e.g. ALBs
   * default to 60s). Sockets that miss a pong between ticks are terminated.
   * Default 30_000.
   */
  heartbeatMs?: number;
  /** Inject a logger (e.g. for tests). Defaults to a pino instance. */
  logger?: Logger;
  /**
   * Trust `X-Forwarded-For` for identifying the client IP. Enable this only
   * when deployed behind a trusted reverse proxy that appends the real client
   * IP (e.g. AWS ALB). Defaults to the `TRUST_PROXY` env var (default false).
   */
  trustProxy?: boolean;
  /**
   * Override the metrics sink. By default a CloudWatch EMF emitter is
   * created (flushes every METRICS_FLUSH_MS, default 60_000 ms). Pass
   * `nullMetrics` to disable.
   */
  metrics?: Metrics;
  /**
   * This relay's public URL (e.g. `wss://relay.example.com`), used to verify
   * the `relay` tag on NIP-42 AUTH events. Defaults to `RELAY_PUBLIC_URL` env.
   */
  relayUrl?: string;
  /**
   * Override the default auth policy. By default we apply NIP-70 protected
   * events (`["-"]` tag → only the author may publish, after NIP-42 AUTH).
   * Pass an explicit policy to extend or replace.
   */
  authPolicy?: AuthPolicy;
  /**
   * Restrict writes to these author pubkeys ("team write"). Defaults to the
   * `WRITE_ALLOWLIST_PUBKEYS` env var (comma/space-separated hex). Empty =
   * open writes.
   */
  writeAllowlist?: Set<string>;
}

export interface RunningServer {
  readonly port: number;
  stop(): Promise<void>;
}

function defaultLogger(): Logger {
  const fallback = process.env.NODE_ENV === "production" ? "info" : "debug";
  return pino({
    level: process.env.LOG_LEVEL ?? fallback,
    base: { service: "relay", version: process.env.RELAY_VERSION ?? "dev" },
  });
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveLimits(options: RateLimitOptions): Required<RateLimitOptions> {
  return {
    maxMessageBytes: options.maxMessageBytes ?? intEnv("MAX_MESSAGE_BYTES", 131_072),
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? intEnv("MAX_CONNS_PER_IP", 50),
    maxSubsPerConn: options.maxSubsPerConn ?? intEnv("MAX_SUBS_PER_CONN", 50),
    eventRatePerSecond: options.eventRatePerSecond ?? intEnv("EVENT_RATE_PER_SEC", 5),
    eventRateBurst: options.eventRateBurst ?? intEnv("EVENT_RATE_BURST", 20),
  };
}

function resolveSweepers(options: SweeperOptions): {
  expiredSweepMs: number;
  tombstonePruneMs: number;
  tombstoneTtlSeconds: number | undefined;
} {
  const envTtl = process.env.TOMBSTONE_TTL_SECONDS;
  const tombstoneTtlSeconds =
    options.tombstoneTtlSeconds ??
    (envTtl !== undefined && envTtl !== "" ? Number.parseInt(envTtl, 10) : undefined);
  return {
    expiredSweepMs: options.expiredSweepMs ?? intEnv("EXPIRED_SWEEP_INTERVAL_MS", 60_000),
    tombstonePruneMs: options.tombstonePruneMs ?? intEnv("TOMBSTONE_PRUNE_INTERVAL_MS", 3_600_000),
    tombstoneTtlSeconds:
      Number.isFinite(tombstoneTtlSeconds) && (tombstoneTtlSeconds as number) > 0
        ? (tombstoneTtlSeconds as number)
        : undefined,
  };
}

/**
 * Resolve the client IP. When `trustProxy` is true we read the *rightmost*
 * value from `X-Forwarded-For` — AWS ALBs (and most reverse proxies) append
 * the true client IP, so anything further left in the header may have been
 * attacker-supplied. With `trustProxy` false (the default), we ignore XFF
 * entirely and use the direct socket peer.
 */
function remoteAddrFor(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress ?? undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Parse a comma/whitespace-separated list of 64-char hex pubkeys (lowercased).
 * Malformed entries are dropped. An empty result disables the write allowlist.
 */
function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => HEX_64.test(s)),
  );
}

export function startRelay(options: StartOptions = {}): Promise<RunningServer> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://relay:relay@localhost:5432/relay";
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const logger = options.logger ?? defaultLogger();
  const limits = resolveLimits(options);
  const sweepers = resolveSweepers(options);
  const trustProxy = options.trustProxy ?? boolEnv("TRUST_PROXY", false);

  const ownsMetrics = options.metrics === undefined;
  const emf: EmfMetrics | null = ownsMetrics
    ? createEmfMetrics({
        logger,
        flushMs: intEnv("METRICS_FLUSH_MS", 60_000),
        dimensions: { service: "relay" },
      })
    : null;
  const metrics: Metrics = options.metrics ?? emf ?? nullMetrics;

  const { db, client } = createDb(databaseUrl);
  const store = new EventStore(db, { logger, metrics });
  const registry = new SubscriptionRegistry({ maxPerConnection: limits.maxSubsPerConn });
  const eventRateLimiter = new RateLimiter({
    tokensPerSecond: limits.eventRatePerSecond,
    burst: limits.eventRateBurst,
  });
  const relayUrl = options.relayUrl ?? process.env.RELAY_PUBLIC_URL;
  // Default write policy = NIP-70 protected events + a "team write" allowlist
  // (empty = open writes). A caller's own `canWrite` is composed on top so its
  // checks run last. When `options.writeAllowlist` is given (tests), the list
  // is a fixed set; otherwise it's the live, DB-backed source — it loads the
  // `write_allowlist` table, seeds once from `WRITE_ALLOWLIST_PUBKEYS`, and
  // refreshes on NOTIFY (admin UI) plus a poll fallback, all without a restart.
  let allowlistSource: AllowlistSource | null = null;
  let allowlistGetter: () => ReadonlySet<string>;
  if (options.writeAllowlist) {
    const fixed = options.writeAllowlist;
    allowlistGetter = () => fixed;
    if (fixed.size > 0) {
      logger.info({ allowlistSize: fixed.size }, "write allowlist enabled (static)");
    }
  } else {
    const source = createAllowlistSource({
      db,
      client,
      logger,
      seed: parseAllowlist(process.env.WRITE_ALLOWLIST_PUBKEYS),
      pollMs: intEnv("ALLOWLIST_REFRESH_MS", 30_000),
    });
    allowlistSource = source;
    allowlistGetter = () => source.current();
  }
  const writeChecks: NonNullable<AuthPolicy["canWrite"]>[] = [
    protectedEventsPolicy(),
    writeAllowlistPolicy(allowlistGetter),
  ];
  if (options.authPolicy?.canWrite) writeChecks.push(options.authPolicy.canWrite);
  // Parcel21: optionally restrict writes to a kind allowlist (e.g. "1059,21059"
  // for NIP-59 gift wraps). Empty/unset = accept all kinds (general relay).
  const kindAllowlist = new Set(
    (process.env.RELAY_KIND_ALLOWLIST ?? "")
      .split(/[\s,]+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n)),
  );
  if (kindAllowlist.size > 0) writeChecks.push(kindAllowlistPolicy(kindAllowlist));
  const authPolicy: AuthPolicy = {
    canRead: options.authPolicy?.canRead,
    canWrite: composeWritePolicies(...writeChecks),
  };
  const relay = createRelay({
    store,
    registry,
    logger,
    eventRateLimiter,
    metrics,
    relayUrl,
    authPolicy,
  });

  const connections = new Map<string, WebSocket>();
  const alive = new WeakSet<WebSocket>();
  const ipConns = new Map<string, Set<string>>();
  const wsLog = logger.child({ component: "ws" });

  emf?.gaugeProvider("connections_active", () => connections.size);
  emf?.gaugeProvider("subscriptions_active", () => registry.size());
  emf?.gaugeProvider("ip_buckets", () => ipConns.size);

  logger.info(
    {
      maxMessageBytes: limits.maxMessageBytes,
      maxConnectionsPerIp: limits.maxConnectionsPerIp,
      maxSubsPerConn: limits.maxSubsPerConn,
      eventRatePerSecond: limits.eventRatePerSecond,
      eventRateBurst: limits.eventRateBurst,
    },
    "rate limits",
  );

  const http = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    const accept = req.headers.accept ?? "";
    if (
      req.method === "GET" &&
      (path === "/" || path === "") &&
      accept.includes("application/nostr+json")
    ) {
      res.writeHead(200, {
        "Content-Type": "application/nostr+json",
        ...CORS_HEADERS,
      });
      res.end(JSON.stringify(getRelayInfo({ limits })));
      return;
    }

    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("nostr relay — connect via websocket");
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxMessageBytes,
  });

  // Per-IP connection cap: check on upgrade and reject with 429 before we
  // even touch the WebSocket upgrade machinery.
  http.on("upgrade", (req, socket: Duplex, head) => {
    const ip = remoteAddrFor(req, trustProxy) ?? "unknown";
    const cell = ipConns.get(ip) ?? new Set<string>();
    if (cell.size >= limits.maxConnectionsPerIp) {
      metrics.increment("connections_rejected_per_ip");
      wsLog.warn({ ip, existing: cell.size }, "conn rejected: per-ip cap");
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\nrate-limited: too many connections from this IP\n",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    const connId = crypto.randomUUID();
    const ip = remoteAddrFor(req, trustProxy) ?? "unknown";
    connections.set(connId, ws);
    alive.add(ws);
    let cell = ipConns.get(ip);
    if (!cell) {
      cell = new Set();
      ipConns.set(ip, cell);
    }
    cell.add(connId);
    metrics.increment("connections_opened");
    wsLog.info({ connId, ip }, "conn open");

    // Emit any messages the orchestrator wants to push on open (NIP-42
    // AUTH challenge). Failure here must NOT take down the process — log
    // and continue; the connection still works for REQ/EVENT/CLOSE.
    void (async () => {
      try {
        for await (const out of relay.handleConnectionOpen(connId)) {
          const target = connections.get(out.connId);
          if (!target || target.readyState !== WebSocket.OPEN) continue;
          target.send(serializeRelayMessage(out.message));
        }
      } catch (err) {
        wsLog.error(
          { connId, err: err instanceof Error ? err.message : String(err) },
          "handleConnectionOpen failed",
        );
      }
    })();

    ws.on("pong", () => alive.add(ws));

    // Without this, a protocol error (e.g. oversized frame past maxPayload)
    // emits an unhandled `error` event that can take down the Node process.
    ws.on("error", (err) => {
      wsLog.warn({ connId, err: err.message }, "ws error");
      ws.terminate();
    });

    ws.on("message", (raw: Buffer) => {
      void dispatch(relay, connections, connId, raw.toString());
    });

    ws.on("close", (code, reason) => {
      connections.delete(connId);
      alive.delete(ws);
      const entry = ipConns.get(ip);
      if (entry) {
        entry.delete(connId);
        if (entry.size === 0) ipConns.delete(ip);
      }
      relay.handleDisconnect(connId);
      metrics.increment("connections_closed");
      wsLog.info({ connId, code, reason: reason.toString() }, "conn close");
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const timers: NodeJS.Timeout[] = [heartbeat];

  if (sweepers.expiredSweepMs > 0) {
    const t = setInterval(() => {
      store.sweepExpired().catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "sweepExpired failed",
        );
      });
    }, sweepers.expiredSweepMs);
    t.unref();
    timers.push(t);
    logger.info({ intervalMs: sweepers.expiredSweepMs }, "expired sweeper scheduled");
  }

  if (sweepers.tombstoneTtlSeconds !== undefined && sweepers.tombstonePruneMs > 0) {
    const ttl = sweepers.tombstoneTtlSeconds;
    const t = setInterval(() => {
      store.pruneTombstones(ttl).catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "pruneTombstones failed",
        );
      });
    }, sweepers.tombstonePruneMs);
    t.unref();
    timers.push(t);
    logger.info(
      { intervalMs: sweepers.tombstonePruneMs, ttlSeconds: ttl },
      "tombstone pruner scheduled",
    );
  }

  return new Promise<RunningServer>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? Number(process.env.PORT ?? 8080), () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      logger.info({ port }, "relay listening");
      resolve({
        port,
        async stop() {
          for (const t of timers) clearInterval(t);
          emf?.flush();
          emf?.stop();
          for (const ws of connections.values()) ws.terminate();
          connections.clear();
          ipConns.clear();
          wss.close();
          await new Promise<void>((res) => http.close(() => res()));
          if (allowlistSource) await allowlistSource.close();
          await client.end();
          logger.info({}, "relay stopped");
        },
      });
    });
  });
}

async function dispatch(
  relay: Relay,
  connections: Map<string, WebSocket>,
  connId: string,
  raw: string,
): Promise<void> {
  for await (const out of relay.handleClientMessage(connId, raw)) {
    const target = connections.get(out.connId);
    if (!target || target.readyState !== WebSocket.OPEN) continue;
    target.send(serializeRelayMessage(out.message));
  }
}

export type { Server };
