# Parcel21 NIP — RGB Consignment Exchange over Nostr

This directory holds the **NIP specification** (Milestone 1), the normative document that the reference
relay and client implement.

## Files

- [`nip-XX-rgb-consignment-exchange.md`](nip-XX-rgb-consignment-exchange.md) — the working draft. `XX` is
  a placeholder until a NIP number is assigned during community review.

## What the NIP defines

1. **Event kinds** for consignment delivery, acknowledgment (ACK/NACK), and media — and whether each is
   regular, ephemeral, or addressable.
2. **Encryption & privacy** — NIP-44 payload encryption inside NIP-59 gift wrapping, so relays cannot
   read contents or correlate sender/receiver.
3. **The exchange flow** — a faithful Nostr mapping of RGB HTTP JSON-RPC v0.2: post consignment →
   retrieve → validate → ACK/NACK → status, including the anonymous-payer ACK return path.
4. **Invoice transport endpoint** — a new Nostr transport type for RGB invoices (relay URLs + payee npub).
5. **Storage** — inline payloads vs. encrypted [Blossom](https://github.com/hzrd149/blossom) blobs for
   large consignments/media, with a size threshold.
6. **Error & immutability semantics** — the proxy's guarantees (immutable consignment, immutable ACK)
   expressed in a relay-less setting.

## Process

The draft is developed in collaboration with the Nostr and RGB communities, then submitted as a PR to
[nostr-protocol/nips](https://github.com/nostr-protocol/nips). See [`../docs/roadmap.md`](../docs/roadmap.md).
