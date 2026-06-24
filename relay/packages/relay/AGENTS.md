# @relay/core

The core NIP-01 implementation for the Nostr relay. Transport-agnostic — a separate `apps/relay` wires it to a WebSocket server.

## Architecture

Organized as a hexagonal core: pure domain logic in the middle, one real storage adapter, and a thin orchestrator. The WebSocket transport lives outside this package entirely.

```
src/
  domain/                 -- pure, zero I/O
    validate.ts           -- validateEvent(raw) -> Result<Event, InvalidReason>
    filter.ts             -- matchesFilter(filter, event) -> boolean
    messages.ts           -- parse/serialize client + relay messages
    subscription.ts       -- SubscriptionRegistry (in-memory, single-process)
  store.ts                -- EventStore class backed by Drizzle / @relay/db
  relay.ts                -- createRelay({ store, registry }) orchestrator
  index.ts                -- public exports
tests/
  domain/                 -- unit tests, no DB
  store.test.ts           -- against real Postgres
  relay.test.ts           -- end-to-end through orchestrator, real Postgres
```

### Responsibilities

- **`domain/`** — all NIP-01 semantic rules live here as pure functions. No `await`, no sockets, no SQL. If a bug is in NIP-01 semantics, it's fixable here alone.
- **`store.ts`** — the only file that speaks SQL. Methods: `save(event)`, `query(filters)` as `AsyncIterable<Event>`. Handles replaceable-event semantics per NIP-01.
- **`relay.ts`** — orchestrator. Parses the client message, calls the store, updates the registry, and returns outgoing messages (including broadcasts to other subscribers). Async, but holds no connection state beyond the registry.
- **Nothing in this package imports `ws`, `uWebSockets.js`, `Bun.serve`, etc.** That's `apps/relay`'s job.

## Testable pattern

The whole point of this split is that 95% of tests need no sockets and no network.

### Layers of tests

| Layer                 | What runs                        | Needs Postgres? |
| --------------------- | -------------------------------- | --------------- |
| `domain/*` unit tests | Pure functions                   | No              |
| `store.test.ts`       | `EventStore` against real schema | Yes             |
| `relay.test.ts`       | Orchestrator wired to real store | Yes             |

We skip in-memory store fakes on purpose — Postgres is cheap to run locally via `docker compose`, and a single real backend avoids divergence between a fake and production behavior.

### Postgres test setup

- `docker compose up -d` must be running. Tests connect to the same local DB as development.
- **Isolation**: each DB-touching test runs `TRUNCATE events, event_tags RESTART IDENTITY CASCADE` in `beforeEach`. Simple and fast at our scale; revisit if the suite grows slow.
- **`fileParallelism: false`** in `vite.config.ts` — multiple test files share the same Postgres database, so they must run serially. Tests within a single file still run in order via Vitest defaults.

### Event fixtures

- Use `nostr-tools` (vendored at `references/nostr-tools`) to generate signed events with real keys inside tests. Don't hand-roll sigs.
- Canonical bad events (malformed id, bad sig, wrong pubkey, etc.) are hand-crafted in `tests/domain/fixtures.ts`.

### Orchestrator test style

Tests should read like a script of client messages with assertions on the outgoing message stream. Example shape:

```ts
const relay = createRelay({ store, registry });

const out1 = await collect(relay.handleClientMessage("conn-a", reqMessage));
expect(out1).toEqual([{ connId: "conn-a", message: eoseMessage("sub1") }]);

const out2 = await collect(relay.handleClientMessage("conn-b", eventMessage));
expect(out2).toContainEqual({ connId: "conn-a", message: eventRelayMessage("sub1", event) });
expect(out2).toContainEqual({ connId: "conn-b", message: okMessage(event.id, true) });
```

## Scope

NIP-01 only for this pass. Out of scope until called out explicitly:

- NIP-09 deletes
- NIP-11 relay info document
- NIP-42 auth
- NIP-45 counts
- Replaceable/addressable events beyond what NIP-01 itself specifies

## References

- NIP-01 spec: `references/nips/01.md`
- nostr-tools source: `references/nostr-tools`
