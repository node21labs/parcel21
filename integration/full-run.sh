#!/usr/bin/env bash
#
# Self-contained Parcel21 × rgb-sandbox run: boot Docker, start the relay, run the integration,
# keep artifacts. Captures everything to integration/last-run.log so it survives /tmp wipes.
# Designed to run as one background job (so the relay stays up for the whole transfer).

set -uo pipefail
ROOT="/Users/nicholaschiarulli/RGB/parcel21-protocol"
LOG="$ROOT/integration/last-run.log"
exec > >(tee "$LOG") 2>&1

echo "== booting Docker =="
open -a Docker || true
for _ in $(seq 1 180); do docker info >/dev/null 2>&1 && break; sleep 1; done
if ! docker info >/dev/null 2>&1; then echo "ERROR: Docker daemon never became ready"; exit 1; fi
echo "Docker ready"

echo "== starting relay =="
PARCEL21_DB_PATH="$ROOT/relay/data/parcel21.lmdb" PARCEL21_PORT=7777 RUST_LOG=parcel21_relay=warn \
  "$ROOT/relay/target/debug/parcel21-relay" &
RELAY_PID=$!
trap 'kill "$RELAY_PID" 2>/dev/null' EXIT
for _ in $(seq 1 40); do lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
if ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; then echo "ERROR: relay did not bind"; exit 1; fi
echo "relay up (pid $RELAY_PID)"

echo "== running rgb-sandbox scenario 100 over Parcel21 (keeping artifacts) =="
# SKIP_STOP=1 keeps data dirs + services so we can inspect the real delivered consignment.
SKIP_STOP=1 PARCEL21_RELAY=ws://127.0.0.1:7777 bash "$ROOT/integration/run.sh" 100
echo "INTEGRATION EXIT: $?"
