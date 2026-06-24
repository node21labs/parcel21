# Parcel21 client

The reference web client (Milestone 3) for RGB consignment exchange over Nostr —
[TanStack Start](https://tanstack.com/start) + [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools).
Send and receive consignments, validate, and ACK/NACK — all over Nostr, against the reference relay.

## Run it

```sh
npm install
npm run dev            # http://localhost:3000  (needs the relay running — see ../relay)
```

Start the relay first (from the repo root): `docker compose up --build relay` or
`cargo run --release --manifest-path relay/Cargo.toml`. Set the relay URL on the Home page.

- **Home** (`/`) — your identity, relay config, and a one-click **live round-trip demo** that runs the
  whole protocol in the browser (payer → payee → ACK) against the relay.
- **Receive** (`/receive`) — generate an invoice with an `rgbnostr:` endpoint, watch for inbound
  consignments, and Accept/Reject (ACK/NACK).
- **Send** (`/send`) — paste an invoice, deliver a (simulated) consignment, and watch the ACK arrive live.

Open `/receive` in one tab and `/send` in another (or two devices) for a full cross-party round-trip.

## The protocol library

[`src/lib/parcel21.ts`](src/lib/parcel21.ts) is the framework-agnostic heart of the client (no TanStack
imports), implementing the client side of [the NIP](../spec/nip-XX-rgb-consignment-exchange.md):

| Function | Maps to | Role |
|---|---|---|
| `parseRgbNostrEndpoint` | invoice transport (NIP §5) | parse `rgbnostr:<npub>?relay=…` |
| `postConsignment` | `consignment.post` | payer gift-wraps + publishes a consignment |
| `subscribeInbound` | `consignment.get` | payee receives + authenticates inbound consignments |
| `postAck` | `ack.post` | payee gift-wraps ACK/NACK to the payer's reply mailbox |
| `subscribeAck` | `ack.get` | payer subscribes (not polls) for the ACK |
| `verifiedUnwrap` | NIP §2.1 | **authenticated** gift-wrap unwrap (the security core) |

### Security note (do not skip)

`nostr-tools`' `unwrapEvent` performs only two NIP-44 decryptions and **no authentication** — and the
rumor is unsigned. A forged gift wrap could otherwise inject a consignment, or forge an `ACK` to the
payer's reply mailbox and trigger a Bitcoin broadcast. This library therefore never calls `unwrapEvent`
for trust decisions; `verifiedUnwrap` verifies the seal signature, binds `seal.pubkey === rumor.pubkey`,
and recomputes `rumor.id`. The adversarial review that caught this is encoded as NIP §2.1.

## Verify it

```sh
npm run typecheck                  # tsc over the whole app + protocol lib
npx tsx scripts/verify-protocol.ts # round-trip + forged-ACK-rejection proof (3/3 checks)
npx tsx scripts/smoke-e2e.ts       # live round-trip against a running relay (PARCEL21_RELAY=ws://…)
```

## Project layout

```
src/
├── routes/        # TanStack Start file routes: __root, index (home+demo), send, receive
├── components/    # small shared UI (Card, Button, StatusPill, LogPanel)
├── lib/
│   ├── parcel21.ts   # the protocol library (gift-wrap encode/decode, verifiedUnwrap)
│   ├── identity.ts   # in-app key (persisted); NIP-07 detection
│   ├── relay.ts      # SimplePool + relay URL config
│   ├── invoice.ts    # build/parse the demo rgbnostr invoice
│   └── hooks.ts      # useIdentity / useRelay / useLog (SSR-safe)
└── router.tsx, styles.css
```

Stack (verified at build time): TanStack Start (Vite-plugin model) on **Vite 8 / React 19.2**,
file-based routing, Tailwind v4, `nostr-tools` 2.23.x. Exact versions are pinned in `package-lock.json`.

## Status / TODO

- [x] Protocol library (typechecks; verified round-trip + forgery rejection)
- [x] TanStack Start app shell + Home/Send/Receive routes; renders and round-trips live in-browser
- [x] In-app identity + NIP-07 detection
- [ ] Full NIP-07 signing (needs a signer-interface refactor of the protocol lib — NIP-07 never exposes the secret key)
- [ ] Blossom upload/download for large consignments (`uploadCiphertextToBlossom` is stubbed)
- [ ] First-validated-wins pinning wired to **real** RGB consignment validation (currently simulated bytes)
- [ ] End-to-end demo against the rgb-sandbox regtest flow
