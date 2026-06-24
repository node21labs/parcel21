# Parcel21 demo-orchestrator

A hosted, one-click demo: each click runs a **real RGB asset transfer**, hands the consignment off
**over the Parcel21 / Nostr relay** (not a centralized proxy), settles it in a real Bitcoin
transaction on public [Mutinynet](https://mutinynet.com), and returns three artifacts you can verify
yourself — a Bitcoin explorer link, a Nostr gift-wrap (`nevent`), and the RGB contract id.

It reuses the reference client's protocol library verbatim (`postConsignment` / `verifiedUnwrap` /
ACK round-trip) and the exact `rgb-cmd` / `bp-wallet` flow proven in
[`../integration/PROOF-mutinynet.md`](../integration/PROOF-mutinynet.md).

## How a run works

```
recipient invoice (witness)                                  rgb invoice --address-based
  → sender builds transfer  (real fee estimation, indexer)   rgb transfer
  → gift-wrap + publish to the relay  ──Nostr──▶ receiver    postConsignment (kind 1059)
  → receiver runs rgb validate, posts an authenticated ACK   verifiedUnwrap + rgb validate
  → ONLY THEN sender broadcasts the Bitcoin witness tx       bp-hot sign + rgb finalize -p
  → receiver accepts — now owns the asset                    rgb accept
```

Broadcast happens only after a verified ACK, so a forged ACK can never trigger an on-chain tx.

## API

| Route | Purpose |
|---|---|
| `GET /` | the one-click demo page (`public/index.html`) |
| `GET /health` | readiness, issuer balance, contract, funding address |
| `POST /run` | enqueue a run (single-concurrency FIFO; `202 {jobId}`; `429` if busy / per-IP cooldown; `503` if unfunded) |
| `GET /run/:id` | final JSON result (or status + buffered events) |
| `GET /run/:id/stream` | WebSocket: live progress events, then the result/error |

Runs are strictly serialized (a Bitcoin wallet can't build two transfers from one UTXO set at once).

## Architecture

- `src/config.ts` — all env knobs.
- `src/rgb.ts` — async wrappers over the `rgb` / `bp-hot` binaries + persistent wallet/contract bootstrap.
- `src/relay.ts` — the gift-wrap hop over the live relay (reuses the vendored protocol lib).
- `src/demo.ts` — `runDemo()`: one transfer, emitting progress.
- `src/server.ts` — Fastify + WebSocket + the run queue.
- `src/_vendor/parcel21.ts` — **vendored** copy of `../client/src/lib/parcel21.ts` (source of truth).
  Refresh with `npm run vendor` after changing the protocol library.

## Run locally

```sh
npm install
RGB_BIN=/abs/path/to/rgb BP_HOT_BIN=/abs/path/to/bp-hot \
DATA_DIR=./data SEED_PASSWORD='something' PORT=8090 \
npm run dev
# open http://localhost:8090, fund the issuer address shown by /health, click Run
```

## Deploy (Railway)

New service, Dockerfile builder, with a persistent volume and a one-time issuer funding.

1. **Service** → root directory `parcel21-protocol/demo-orchestrator`, builder = Dockerfile.
   (First build compiles `rgb-cmd` + `bp-wallet` from source — several minutes; cached after.)
2. **Volume** mounted at `/data` (wallet descriptors + RGB stash survive restarts).
3. **Env**:
   - `SEED_PASSWORD` (secret) — bp-hot seed password.
   - `PARCEL21_RELAY=wss://relay-production-1664.up.railway.app`
   - defaults already target Mutinynet: `BITCOIN_NETWORK=signet`,
     `ESPLORA_SERVER=https://mutinynet.com/api`, `EXPLORER_TX_BASE=https://mutinynet.com/tx`,
     `FAUCET_URL=https://faucet.mutinynet.com`.
4. **Fund once**: open the deployed URL (or `GET /health`) to get the issuer address, send test sats
   from the faucet, reload. The orchestrator then issues the demo contract and is ready.

### Switch to standard signet
Set `ESPLORA_SERVER=https://mempool.space/signet/api`,
`EXPLORER_TX_BASE=https://mempool.space/signet/tx`, `FAUCET_URL=https://signetfaucet.com`. The network
stays `signet`. Note: ~10-minute blocks make the live confirmation slower than Mutinynet's 30 s.

## Caveats

- `rgb-cmd` 0.11.1-rc.7 / `bp-wallet` 0.11.1-alpha.2 are RC/alpha, **test networks only**.
- Mutinynet is centrally operated and periodically reset; a reset wipes the issuer wallet — refund it
  and (if the stash was wiped) clear `/data` to re-bootstrap.
- Large consignments (> ~32–40 KB) need the Blossom path, which is still a stub; the demo asset's
  consignment is ~6 KB and rides inline.
