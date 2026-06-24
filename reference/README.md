# Reference repositories

These are upstream RGB repositories Parcel21 **aligns against**. They are fetched for study, not
redistributed — the clones are git-ignored (see [`../.gitignore`](../.gitignore)). Re-fetch them with:

```sh
git clone --depth 1 https://github.com/RGB-Tools/rgb-proxy-server.git    reference/rgb-proxy-server
git clone --depth 1 https://github.com/RGB-Tools/rgb-http-json-rpc.git   reference/rgb-http-json-rpc
```

## Why these matter

Parcel21 is a **decentralized transport** for the same job these repos do centrally. To be a credible
drop-in, our NIP must reproduce their exact semantics.

- **[rgb-http-json-rpc](https://github.com/RGB-Tools/rgb-http-json-rpc)** — the protocol spec (v0.2) we
  mirror. Defines the seven methods (`server.info`, `consignment.post/get`, `media.post/get`,
  `ack.post/get`), their params, return values, and error codes. This is the contract.
- **[rgb-proxy-server](https://github.com/RGB-Tools/rgb-proxy-server)** — the reference implementation.
  Its `src/controllers/api.ts` reveals the *behavioral* invariants the spec text leaves implicit:
  consignments are content-addressed and **immutable once posted** (re-posting an identical file is a
  no-op `false`; a *different* file errors `-101`), and an ACK is **immutable once set** (`-100`).

## Behavioral invariants Parcel21 must preserve

| Invariant | Source | Parcel21 equivalent |
|---|---|---|
| A `recipient_id` (blinded UTXO) keys exactly one consignment | proxy `consignments.recipient_id UNIQUE` | First valid gift-wrapped consignment for a recipient wins; later conflicting ones are ignored |
| Consignment immutable once posted | proxy `-101 CannotChangeUploadedFile` | Consignment events are non-replaceable; receiver pins the first it validates |
| ACK immutable once set | proxy `-100 CannotChangeAck` | First ACK/NACK from the payee is authoritative |
| ACK is `true` / `false` / `null` (pending) | proxy `ack.get` | Presence/absence of the ack event; value in payload |
| Files returned base64-encoded | proxy `consignment.get` | Inline base64 in the encrypted rumor (small) or Blossom ciphertext ref (large) |

See [`../docs/architecture.md`](../docs/architecture.md) for the full mapping.

## Also referenced (not vendored)

- [RGB sandbox](https://github.com/RGB-Tools/rgb-sandbox) — the regtest demo of the end-to-end RGB
  transfer flow this transport plugs into (kept at `../../rgb-sandbox` in this workspace).
- [RGB-WG/rgb-wallet](https://github.com/RGB-WG/rgb-wallet) — RGB invoice + transport-endpoint format,
  the integration point for a new Nostr transport type.
