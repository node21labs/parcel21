# Proof: real RGB transfer over Parcel21

A captured successful run of [`full-run.sh`](full-run.sh) (rgb-sandbox scenario 100: a single blinded
RGB asset transfer, broadcast + mined on regtest), where the consignment hand-off went **over
Parcel21/Nostr** instead of the sandbox's `cp`. This is Milestone 3's "end-to-end demonstration with
real RGB consignment data."

Environment: Apple-Silicon (arm64) macOS, Docker, amd64 regtest images under emulation; the reference
relay on `ws://127.0.0.1:7777`; `rgb-cmd` 0.11.1-rc.7, `bp-wallet` 0.11.1-alpha.2.

## What happened

1. A real RGB contract (NIA "usdt", supply 2000) was issued on regtest.
2. The sender ran `rgb transfer`, producing a real `consignment_0.rgb`.
3. **Instead of `cp`, the consignment was gift-wrapped and published to the relay**, received on the
   other side, sha256-verified, and ACK'd — written byte-for-byte into the recipient's data dir.
4. The sandbox's own `rgb validate` accepted the relayed file; the Bitcoin tx was broadcast + mined;
   the recipient ran `rgb accept`.
5. Final balances confirm the transfer settled: receiver now owns 100 usdt.

## Transcript (key lines, from `last-run.log`)

```
A new contract rgb:qfbcqLLN-5Cjr_k_-0i3jdQ7-uU5gdnW-Dt2VnER-te9~mKA is issued and added to the stash.
-- (sender) preparing RGB transfer
  [parcel21] delivering consignment_0.rgb over Nostr -> ws://127.0.0.1:7777
payer  → posted consignment (sha256 4c65ce18f499…)
payee  ← received consignment (author 9a4dba8ee13b…, inline)
payee  ✓ wrote …/rgb-sandbox/data1/consignment_0.rgb (5126 bytes, sha256 4c65ce18f499…)
payee  → posted ACK
payer  ← received ACK (authenticated to payee) ✓
-- (recipient) validating consignment
-- (sender) finalizing and broadcasting the PSBT
Publishing transaction via electrum ... success
-- (recipient) accepting transfer
-- final balances
balance 1900 for contract rgb:qfbcqLLN-…-te9~mKA (usdt) matches the expected one   # sender change
balance  100 for contract rgb:qfbcqLLN-…-te9~mKA (usdt) matches the expected one   # receiver
====                sandbox run finished                ====
INTEGRATION EXIT: 0
```

## Byte-perfect delivery

The consignment that the receiver validated and accepted is identical to what the sender produced —
delivered intact over the relay:

```
sender   rgb-sandbox/data0/consignment_0.rgb : 4c65ce18f4999958d1a850b42a8b16e55f511e39b0caeaf51e68e04814e93a82
receiver rgb-sandbox/data1/consignment_0.rgb : 4c65ce18f4999958d1a850b42a8b16e55f511e39b0caeaf51e68e04814e93a82
```

## Scope notes

- The consignment was 5126 bytes — it rode **inline** (NIP-44 + NIP-59). Consignments larger than the
  ~32–40 KB inline cap need the Blossom path, which is not yet implemented.
- The harness ran in transport mode (`--no-validate`): it does the sha256 integrity check + ACK; the
  **RGB validation** is the sandbox's own `rgb validate` step immediately after (which passed — the run
  `_die`s otherwise, and the matching balances confirm settlement).
- Reproduce with `bash integration/full-run.sh` (see [`README.md`](README.md) for host caveats).
