# Proof: real RGB transfer on a public Bitcoin network

A captured successful run of [`mutinynet-dryrun.sh`](mutinynet-dryrun.sh) — a real RGB asset issued and
transferred on **public [Mutinynet](https://mutinynet.com)** (a custom Bitcoin signet with 30-second
blocks), settled in a real on-chain witness transaction that **anyone can verify on a public explorer**.
No local `bitcoind`, no `electrs`, no Docker — only the public Mutinynet Esplora indexer. This is the
"real explorer" counterpart to the regtest [`PROOF.md`](PROOF.md).

Environment: Apple-Silicon (arm64) macOS; `rgb-cmd` 0.11.1-rc.7, `bp-wallet` 0.11.1-alpha.2; network
`signet` pointed at `--esplora=https://mutinynet.com/api`. (rgb-cmd treats Mutinynet as standard signet —
it is signet at the network/address level — so the same binary works against standard signet by swapping
only the Esplora URL.)

## What happened

1. An issuer wallet was created and funded **once** from the Mutinynet faucet (100,000 sats) — the only
   human-in-the-loop step.
2. A real RGB contract (NIA "USDT", supply 2000) was **issued** against the funded UTXO on public signet.
3. The recipient produced an **address-based (witness) invoice** — no recipient pre-funding needed.
4. The sender ran `rgb transfer`, producing a real 5,085-byte consignment + a PSBT, with **fee estimation
   coming from the public indexer** (not regtest).
5. The recipient ran `rgb validate` → *"The provided consignment is valid"*.
6. The sender **signed, finalized and broadcast** the witness transaction to the public network via
   Esplora → *"Publishing transaction via esplora ... success"*.
7. The recipient ran `rgb accept`; its contract state confirms it now **owns 100 USDT**, anchored to the
   confirmed witness tx.

## Verifiable artifacts

| Artifact | Value |
|---|---|
| Network | Mutinynet (signet), indexer `https://mutinynet.com/api` |
| RGB contract id | `rgb:ZBOFyfVg-nPKujpq-TBG7k2D-A60oxwo-IJjiWkM-KdQ7OjY` (NIA "USDT", supply 2000) |
| Funding tx | [`ed6b07dd…2766acef`](https://mutinynet.com/tx/ed6b07dd7178f488405284c0e138758a0f8d7a615150ecad151a0a702766acef) — 100,000 ṩ, block 3,207,469 |
| Issuance UTXO | `ed6b07dd…2766acef:0` |
| Consignment | 5,085 bytes — rides **inline** (under the ~32–40 KB NIP-44/59 cap) |
| **Witness tx (the on-chain proof)** | [`051a6300…8718e37e`](https://mutinynet.com/tx/051a6300b37bd9b1817415aced981964d6fba4dfafbf6a48078305778718e37e) — block 3,207,474, fee 400 ṩ, 1 vin / 2 vout |
| Recipient holding | 100 USDT @ `051a6300…8718e37e:1` |

## Transcript (key lines)

```
A new contract rgb:ZBOFyfVg-nPKujpq-TBG7k2D-A60oxwo-IJjiWkM-KdQ7OjY is issued and added to the stash.
invoice: rgb:ZBOFyfVg-…/~/BF/sb:wvout:BXLEEwdM-…-uS8TE7A
consignment bytes:     5085   psbt bytes:     1408
The provided consignment is valid
Finalizing PSBT ... 1 of 1 inputs were finalized, transaction is ready for the extraction
Publishing transaction via esplora ... success
Transfer accepted into the stash
Owned:
  assetOwner:
          100  051a6300b37bd9b1817415aced981964d6fba4dfafbf6a48078305778718e37e:1  (bitcoin:3207474)
```

## Scope notes

- This proof isolates the **RGB-on-public-signet** legs (issue → transfer → broadcast → accept). The
  Nostr relay hand-off (gift-wrap over the Parcel21 relay) is proven separately in [`PROOF.md`](PROOF.md)
  and is wired into this same flow by the hosted demo orchestrator.
- rgb-cmd / bp-wallet are RC/alpha and test-only — signet only, no mainnet assurances.
- Reproduce: `bash integration/mutinynet-dryrun.sh setup`, fund the printed address at
  https://faucet.mutinynet.com, then `bash integration/mutinynet-dryrun.sh run`. Switch to standard
  signet by setting `ESPLORA=https://mempool.space/signet/api` and `EXPLORER_TX=https://mempool.space/signet/tx`.
