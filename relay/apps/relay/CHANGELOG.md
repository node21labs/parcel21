# @relay/app

## 0.8.0

### Minor Changes

- 2949996: NIP-70 protected events. Events with the `["-"]` tag may only be published by their author, after NIP-42 AUTH.
  - **`@relay/core`** exports `protectedEventsPolicy()` (a `canWrite` fragment), `isProtectedEvent(e)`, and `composeWritePolicies(...)` for chaining policies.
  - **`apps/relay`** wires `protectedEventsPolicy()` as the default `canWrite`. Operators passing a custom `authPolicy.canWrite` get it composed with the NIP-70 check first — protected events stay gated unless the operator removes it explicitly.
  - **Rejection prefix**: `auth-required: this event may only be published by its author` — matches the spec example flow and prompts compliant clients to AUTH and retry.
  - **`AuthPolicy` interface** updated to use arrow-function shaped methods so call sites can extract them without `unbound-method` lint warnings.
  - `supported_nips` → `[1, 9, 11, 40, 42, 70]`.

### Patch Changes

- Updated dependencies [2949996]
  - @relay/core@0.5.0

## 0.7.0

### Minor Changes

- 17d08ee: NIP-42 client authentication.

  **What's new**
  - **`AUTH` message type** in both directions. Relay emits `["AUTH", challenge]` on every connection open; client responds with `["AUTH", signedEventKind22242]`.
  - **Kind 22242 validation**: enforces the four spec requirements — kind, ±10 min `created_at` window, challenge match, relay URL host match (case-insensitive).
  - **`ConnectionAuth` registry**: per-connection challenge and set of authenticated pubkeys. Cleared on disconnect.
  - **Kind 22242 hardening**: events submitted via `EVENT` (instead of `AUTH`) are accepted with `OK(true, "mute: use AUTH message for kind 22242")` — never stored, never broadcast, per spec.
  - **`AuthPolicy` hook** on `createRelay`: `canRead({ connId, filters, authenticatedPubkeys })` gates REQ; `canWrite({ connId, event, authenticatedPubkeys })` gates EVENT. Returns `auth-required` or `restricted` with an optional message.
  - **Default behavior: unrestricted.** `supported_nips` advertises `42` so clients try to authenticate proactively, but no restrictions apply until an operator wires an `authPolicy`. This unblocks future work (NIP-70 protected events, NIP-17 gift-wrapped DMs, paid relay) without forcing it now.
  - **New relay method**: `Relay.handleConnectionOpen(connId)` — transports call it to push the initial challenge.
  - **Config**: `RELAY_PUBLIC_URL` env var (required for AUTH to accept events; without it, AUTH events are rejected with `restricted: relay url not configured`). Terraform sets this to the ECS-managed domain.

### Patch Changes

- Updated dependencies [17d08ee]
  - @relay/core@0.4.0

## 0.6.0

### Minor Changes

- 1551f2f: CloudWatch metrics via Embedded Metric Format (EMF). The relay now emits aggregated metrics every 60s (configurable via `METRICS_FLUSH_MS`) as a single structured log line per flush; CloudWatch Logs auto-parses these into real CloudWatch Metrics — no scraping agent or sidecar needed.

  **Metrics emitted**
  - Counters: `events_received`, `events_stored`, `events_duplicate`, `events_outdated`, `events_ephemeral`, `events_blocked`, `events_expired`, `events_invalid`, `events_rate_limited`, `messages_parse_errors`, `subscriptions_opened`, `subscriptions_closed`, `subscriptions_rejected`, `connections_opened`, `connections_closed`, `connections_rejected_per_ip`, `broadcasts_sent`, `queries`, `sweep_expired_removed`, `sweep_tombstone_events_removed`, `sweep_tombstone_addressables_removed`
  - Timings (statistic-set arrays): `event_save_duration_ms`, `query_duration_ms`
  - Gauges (read at flush): `connections_active`, `subscriptions_active`, `ip_buckets`

  **Design**
  - `@relay/core` exports a minimal `Metrics` interface + `nullMetrics`; call sites in `EventStore` and `createRelay` push into it.
  - `apps/relay` wires a `createEmfMetrics(...)` implementation that buffers in memory and flushes on an interval. Override with `metrics: nullMetrics` to disable.
  - Timing samples are capped per flush (default 1000) so EMF log lines stay bounded.

### Patch Changes

- Updated dependencies [1551f2f]
  - @relay/core@0.3.0

## 0.5.0

### Minor Changes

- bb424fa: Background sweepers to keep storage bounded.
  - **Expired-event sweeper** — `EventStore.sweepExpired()` deletes events whose `expires_at` is in the past. Scheduled every 60s by default; set `EXPIRED_SWEEP_INTERVAL_MS=0` to disable.
  - **Tombstone pruner** (opt-in) — `EventStore.pruneTombstones(olderThanSeconds)` drops stale NIP-09 tombstones so the `deleted_events` / `deleted_addressable` tables don't grow unbounded. Disabled by default; set `TOMBSTONE_TTL_SECONDS` to enable (runs hourly; override with `TOMBSTONE_PRUNE_INTERVAL_MS`). Pruning a tombstone means the original event can be re-published, which is "best-effort" per NIP-09.

  Both sweepers are clock-injectable in `EventStore` for deterministic tests and logged at `info` when they remove anything.

### Patch Changes

- Updated dependencies [bb424fa]
  - @relay/core@0.2.0

## 0.4.0

### Minor Changes

- 8e7bacb: Rate limiting and connection guards. New configurable protections against abusive clients:
  - **`MAX_MESSAGE_BYTES`** (default `131072` / 128 KB) — enforced by the WebSocket transport; oversized frames are rejected before parse.
  - **`MAX_CONNS_PER_IP`** (default `50`) — per-IP cap checked at upgrade; excess upgrades get HTTP 429. Honors `x-forwarded-for` so the ALB's real client IP is used.
  - **`MAX_SUBS_PER_CONN`** (default `50`) — enforced by `SubscriptionRegistry`; the orchestrator emits `CLOSED("rate-limited: …")` for overflow.
  - **`EVENT_RATE_PER_SEC`** (default `5`) / **`EVENT_RATE_BURST`** (default `20`) — token bucket per connection; overflow events get `OK(false, "rate-limited: …")`.

  The NIP-11 info doc now advertises `max_message_length` and `max_subscriptions` so well-behaved clients back off before hitting server-side limits.

  `@relay/core` gains a pure `RateLimiter` class and a `maxPerConnection` option on `SubscriptionRegistry`. All limits are in-memory and single-process; cross-instance coordination (Redis, etc.) is future work.

### Patch Changes

- Updated dependencies [8e7bacb]
  - @relay/core@0.1.0

## 0.3.0

### Minor Changes

- d919db3: Structured logging via pino. `@relay/core` defines a minimal `Logger` interface that pino satisfies (no pino dependency in core). The app wires a pino instance through `EventStore`, `createRelay`, and the WebSocket transport.
  - **Log levels** — `LOG_LEVEL` env var; default `info` in prod, `debug` in dev. Output is JSON for CloudWatch to parse.
  - **What's logged** — per-connection open/close with remote IP (honors `x-forwarded-for` from the ALB), per-message outcomes (EVENT accepted/blocked/expired/invalid, REQ filter/result counts, CLOSE, parse errors), per-save/per-query durations at debug.
  - **Testing** — `nullLogger` exported from `@relay/core` for silent tests; smoke tests wire it in.

## 0.2.0

### Minor Changes

- 556a901: Ship NIP-09 (event deletion) and NIP-40 (expiration timestamps). `supported_nips` now includes `9` and `40`.
  - **NIP-09**: kind-5 deletion requests are stored and applied. `e`-tag targets owned by the same pubkey are removed; `a`-tag addressable coordinates remove all versions at or before the kind-5's `created_at`. Tombstones block re-publishing deleted events. A kind-5 cannot delete another kind-5 per spec.
  - **NIP-40**: events with an `expiration` tag whose timestamp is ≤ now are rejected on receipt; stored events past their expiration are filtered from query results. Malformed `expiration` tags return `OK(false, "invalid: …")`. Storage is retained (sweeper deletion is future work).

## 0.1.0

### Minor Changes

- 34971b4: First managed release. Highlights:
  - **NIP-11 Relay Information Document** — served at `GET /` when `Accept: application/nostr+json` with CORS headers. Reports supported NIPs, version, and limits. Configurable via `RELAY_*` env vars.
  - **GitHub Actions CI/CD** — `test`, `changeset-check`, `release`, `deploy` jobs. AWS OIDC auth (no long-lived keys), ECR push, ECS `--force-new-deployment`, waits for stable.
  - **Changesets** — PRs require a changeset (`bunx changeset` / `bunx changeset --empty`). A "Version Packages" PR aggregates pending changesets; merging it tags the release and rolls the service.
  - **NIPS.md checklist** — tracks phased NIP support plan.
