# Parcel21

Decentralized RGB consignment exchange over Nostr — a trust-minimized alternative to the centralized
proxy servers that RGB transfers depend on today.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
&nbsp;![status](https://img.shields.io/badge/status-early%20development-orange)

[RGB](https://rgb.tech) is a client-side-validated smart contract system on Bitcoin. To complete a
transfer, the sender has to hand the receiver a **consignment** — the off-chain data that proves the
transferred asset rights. Today that hand-off runs over a small number of centralized proxy servers
speaking [RGB HTTP JSON-RPC](https://github.com/RGB-Tools/rgb-http-json-rpc). The operator can read the
consignment and the transfer metadata, receivers have to poll for incoming data, and the whole ecosystem
leans on a handful of public instances that can go down or censor.

Parcel21 moves that hand-off onto [Nostr](https://nostr.com). The sender publishes an encrypted,
gift-wrapped event ([NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) +
[NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)); relays can't read the contents or tell
who is transacting with whom, and the receiver gets the consignment pushed in real time instead of polling.
Anyone can run a relay.

> A real RGB asset transfer has been settled end-to-end over Nostr with Parcel21 (issuance → gift-wrapped
> consignment over the relay → `rgb validate` → broadcast → the receiver owns the asset). See
> [`integration/PROOF.md`](integration/PROOF.md).

## Why this is timely

RGB reached production on Bitcoin mainnet in 2025, and Tether announced USDT issuance over RGB shortly
after. As assets start moving natively on Bitcoin, the consignment-exchange layer becomes load-bearing
infrastructure — and it's the piece Parcel21 decentralizes.

## How it maps to the existing proxy protocol

Parcel21 mirrors the semantics of [RGB HTTP JSON-RPC v0.2](https://github.com/RGB-Tools/rgb-http-json-rpc)
so it can act as a drop-in decentralized transport. Each JSON-RPC method maps to a Nostr mechanism:

| RGB HTTP JSON-RPC | Parcel21 (Nostr) |
|---|---|
| `consignment.post` (payer uploads, keyed by `recipient_id`) | Payer publishes a gift-wrapped consignment event addressed to the payee |
| `consignment.get` (payee downloads) | Payee subscribes for gift wraps addressed to it and unwraps the consignment |
| `ack.post` (payee ACK/NACK) | Payee publishes a gift-wrapped ack to the payer's per-transfer reply key |
| `ack.get` (payer polls status) | Payer subscribes for the ack — push, not poll |
| `media.post` / `media.get` | Same pattern; large blobs offloaded to encrypted [Blossom](https://github.com/hzrd149/blossom) storage |

The proxy's invariants are preserved at the receiver: a consignment for a given `recipient_id` is
write-once, and an ACK is write-once. The full design — event kinds, the anonymous-payer ACK return path,
and the authenticated-unwrap requirement — is in [`docs/architecture.md`](docs/architecture.md) and the
spec.

## Try it

A live demo is deployed:

- **App:** https://client-production-ffe8.up.railway.app — open it and hit "Run round-trip."
- **Relay:** `wss://relay-production-1664.up.railway.app`

### Run locally

Client (web app + protocol library):

```sh
cd client && npm install
npm run typecheck
npx tsx scripts/verify-protocol.ts     # round-trip + forged-ACK rejection (3/3 checks)
npm run dev                            # http://localhost:3000
```

Relay — a TypeScript/Bun + Postgres app; see [`relay/README.md`](relay/README.md) for setup and the
admin UI.

## Repository layout

```
spec/         The NIP: event kinds, encryption, the send/ACK/NACK flow
relay/        Nostr relay (TypeScript/Bun + Postgres) — carries gift-wrapped consignment events; admin UI
client/       Reference web client (TanStack Start) — send/receive/validate/ACK over Nostr
integration/  Drives a real RGB transfer (rgb-sandbox) over Parcel21 instead of a file copy
docs/         Architecture and design notes
```

## Status

Early development; nothing here is production-ready. The NIP is drafted against the real RGB consignment
flow and was adversarially reviewed — the review caught a forgeable-ACK flaw (unauthenticated gift-wrap
unwrap could fake an ACK and trigger a broadcast), and the fix is encoded as a normative requirement. The
relay carries the gift wraps (with an optional Parcel21 kind-allowlist policy) and is deployed; the client
protocol library typechecks and passes a round-trip plus forged-ACK-rejection test; a real RGB asset
transfer has settled end-to-end over Nostr on regtest; and the app + relay are live (see above). Still
ahead: mainnet, the Blossom path for large consignments, and full NIP-07 signer integration.

## Contributing

Contributions are welcome — this is built in the open.

- Read [`docs/architecture.md`](docs/architecture.md) and the spec
  ([`spec/nip-XX-rgb-consignment-exchange.md`](spec/nip-XX-rgb-consignment-exchange.md)) first; the NIP is
  the source of truth and is still evolving, so spec feedback is as valuable as code.
- The relay is TypeScript/Bun + Postgres (`relay/`); the client is TypeScript / TanStack Start (`client/`).
- Run `npm run typecheck` and `npx tsx scripts/verify-protocol.ts` in `client/` before opening a PR.
- Open an issue to discuss anything non-trivial before sending a large change.

## License

[MIT](LICENSE) © 2026 Node21 Labs.

Builds on the [RGB HTTP JSON-RPC](https://github.com/RGB-Tools/rgb-http-json-rpc) protocol and the
[rgb-proxy-server](https://github.com/RGB-Tools/rgb-proxy-server) reference implementation by RGB-Tools.
