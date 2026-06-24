# NIP Support Checklist

Relay-side NIP implementation plan. Client-facing NIPs that only define event kinds without changing relay behavior are not listed — the relay stores and serves them via NIP-01's generic rules.

## Phase 0 — Done

- [x] **[NIP-01](references/nips/01.md)** — Basic protocol. Event format, `EVENT`/`REQ`/`CLOSE`/`OK`/`EOSE`/`CLOSED`/`NOTICE`, filter semantics, replaceable / addressable / ephemeral kinds.

## Phase 1 — Table stakes

- [x] **[NIP-11](references/nips/11.md)** — Relay Information Document. Serve JSON at `GET /` when `Accept: application/nostr+json`. Declares supported NIPs, name, contact, software, limits, fees.
- [x] **[NIP-09](references/nips/09.md)** — Event deletion. Kind `5` events list target event ids in `e` tags; relay removes (or hides) them and rejects re-publishes by the same pubkey.
- [x] **[NIP-40](references/nips/40.md)** — Expiration timestamps. `expiration` tag sets a TTL; relay stops serving and eventually deletes expired events.

## Phase 2 — Common client expectations

- [x] **[NIP-42](references/nips/42.md)** — Client authentication. `AUTH` challenge/response for restricting reads, writes, or specific kinds.
- [x] **[NIP-70](references/nips/70.md)** — Protected events. `-` tag means "only the author may publish this"; combine with NIP-42.
- [ ] **[NIP-50](references/nips/50.md)** — Search capability. `search` filter field runs a full-text search over content.

## Phase 3 — Power features

- [ ] **[NIP-45](references/nips/45.md)** — `COUNT` command. Returns the count of events matching a filter without streaming them.
- [ ] **[NIP-13](references/nips/13.md)** — Proof-of-work. Relay MAY require a minimum difficulty on incoming events.
- [ ] **[NIP-86](references/nips/86.md)** — Relay management API. JSON-RPC over HTTP for admin actions (ban pubkey, allow list, etc.).

## Phase 4 — Opt-in / specialized

- [ ] **[NIP-29](references/nips/29.md)** — Relay-based groups. Large scope; only if we want to host groups.
- [ ] **[NIP-77](references/nips/77.md)** — Negentropy sync. Efficient set-reconciliation between relays and power clients.
- [ ] **[NIP-66](references/nips/66.md)** — Relay discovery / monitoring. We'd publish relay metadata events.
- [ ] **[NIP-26](references/nips/26.md)** — Delegated event signing (rarely used; validate delegation tag if present).

## Not planned

- **NIP-96** file storage — out of scope; separate media-server concern.
- **NIP-46 / 47** — client-side signers and wallet connect; no relay behavior.
- **NIPs defining event kinds only** (02, 04, 10, 17, 18, 21, 23, 24, 25, 27, 28, 31, 32, 34-39, 44, 48, 49, 51-59, 61, 62, 65, 72, 75, 94, 98, 99) — the relay stores and serves these via NIP-01 without special handling.

## Reporting

Every NIP we implement should be added to the `supported_nips` array in the NIP-11 info document (once that exists). Also update `packages/relay/AGENTS.md` "Scope" section as things move from "out of scope" to "shipped".
