# Parcel21 × rgb-sandbox integration

Proves the real thing: a genuine RGB asset transfer where the **consignment hand-off happens over
Parcel21/Nostr** instead of the centralized `cp`/proxy step. It drives the
[rgb-sandbox](https://github.com/RGB-Tools/rgb-sandbox) regtest demo but swaps its consignment copy for
our harness.

See [`PROOF.md`](PROOF.md) for a captured successful run (real asset issued, consignment delivered over
the relay, validated and accepted by the `rgb` CLI, receiver ends up owning the asset).

## How it works

- **`client/scripts/rgb-e2e.ts`** — the harness. Reads a real `consignment.rgb`, gift-wraps it
  (NIP-44 + NIP-59), publishes it to the relay, receives it on the other side, verifies its sha256, and
  ACKs — writing the byte-identical file into the recipient's data dir. Reuses the protocol library.
- **`run.sh`** — generates `demo-parcel21.sh`, a patched copy of the sandbox's `demo.sh` where the line
  `cp data0/consignment.rgb data1/` becomes a call to the harness. Everything else (issue, transfer,
  `rgb validate`, broadcast, `rgb accept`) is the sandbox's own, unmodified logic.
- **`full-run.sh`** — convenience wrapper: boots Docker, starts the relay, runs `run.sh`, keeps
  artifacts, logs to `last-run.log`.

## Run it

```sh
# from the repo root; needs Docker running and the sandbox at ../rgb-sandbox with rgb-cmd/bp-wallet installed
bash integration/full-run.sh            # scenario 100 = single blinded transfer, broadcast+mine
```

Then inspect `integration/last-run.log`, and the kept `rgb-sandbox/data{0,1}` dirs.

## Host caveats (and the fixes baked in)

The sandbox targets Linux/amd64. On an Apple-Silicon (arm64) Mac it runs under emulation, which surfaced
two environment issues — both handled by the runner, **neither a Parcel21 problem**:

1. **electrs ↔ bitcoind startup race.** electrs exits if bitcoind's RPC isn't up yet. Fixed by adding
   `restart: on-failure:10` to the `electrs` service in `rgb-sandbox/docker-compose.yml` (a one-line,
   additive change to the sandbox clone).
2. **Bash sync-check incompatibility.** `demo.sh` polls electrs with `netcat`; this host's
   `netcat`/`nc` is GNU netcat 0.7.1, and the emulated electrs doesn't answer raw socket queries anyway —
   though `rgb-cmd`'s own (Rust) electrum client works fine. `run.sh` therefore **stubs the demo's bash
   sync-check** (rgb-cmd syncs itself; electrs indexes regtest blocks in <1s internally).

On a native Linux/amd64 host neither workaround is needed, but they're harmless there too.

## Status / next

- [x] Real RGB consignment delivered over Parcel21 and accepted by `rgb` — inline payloads (see PROOF.md).
- [ ] Large consignments via Blossom (`uploadCiphertextToBlossom` is stubbed) — needed once a
      consignment exceeds the ~32–40 KB inline cap.
- [ ] Wire the same harness into the web client so the browser flow uses real consignments.
