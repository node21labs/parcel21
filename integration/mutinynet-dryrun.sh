#!/usr/bin/env bash
#
# Parcel21 — public-Mutinynet de-risk dry-run.
#
# Drives rgb-cmd directly against PUBLIC Mutinynet (a custom signet) with NO local
# bitcoind/electrs/Docker — only the Mutinynet Esplora indexer. Proves the legs that
# until now were only proven on regtest (see integration/PROOF.md): a faucet-funded
# issuance UTXO -> issue -> witness transfer -> sign -> finalize+broadcast, with real
# fee estimation coming from the public indexer, ending in a txid that resolves at
# https://mutinynet.com/tx/<txid>.
#
# This is the standalone core the hosted demo-orchestrator will wrap. It does NOT do the
# Nostr relay hop (that is rgb-e2e.ts); it isolates the RGB-on-public-signet question.
#
# Usage:
#   bash integration/mutinynet-dryrun.sh setup    # create wallets, print funding address
#   bash integration/mutinynet-dryrun.sh status   # sync + show issuer UTXOs/balance
#   bash integration/mutinynet-dryrun.sh run       # issue->transfer->broadcast (needs funding)
#   bash integration/mutinynet-dryrun.sh           # setup; run if funded, else tell me to fund
#
set -uo pipefail

# ---- config (env-overridable) ------------------------------------------------
HERE="$(cd "$(dirname "$0")" && pwd)"
# rgb-sandbox is expected alongside the repo (set SANDBOX to override); work dir holds wallets+stash.
SANDBOX="${SANDBOX:-$(cd "$HERE/../.." && pwd)/rgb-sandbox}"
WORK="${WORK:-$HERE/.mutinynet-dryrun}"
NETWORK="${NETWORK:-signet}"
ESPLORA="${ESPLORA:-https://mutinynet.com/api}"
EXPLORER_TX="${EXPLORER_TX:-https://mutinynet.com/tx}"
FAUCET_URL="${FAUCET_URL:-https://faucet.mutinynet.com}"
ISSUE_SUPPLY="${ISSUE_SUPPLY:-2000}"
SEND_AMT="${SEND_AMT:-100}"
SATS="${SATS:-2000}"            # sats placed in the witness output for the recipient
export SEED_PASSWORD="${SEED_PASSWORD:-parcel21 mutinynet dryrun}"

RGB=("$SANDBOX/rgb-cmd/bin/rgb" -n "$NETWORK" "--esplora=$ESPLORA")
BPHOT=("$SANDBOX/bp-wallet/bin/bp-hot")
SCHEMA_NIA="$SANDBOX/rgb-schemas/schemata/NonInflatableAsset.rgb"
TEMPLATE="$SANDBOX/contracts/usdt.yaml.template"

WDIR="$WORK/wallets"
ISS_DATA="$WORK/data_issuer"
RCP_DATA="$WORK/data_recipient"
CONTRACT_YAML="$WORK/usdt.yaml"
CONSIGNMENT="$WORK/consignment.rgb"
PSBT="$WORK/transfer.psbt"
TXFILE="$WORK/transfer.tx"
STATE_DIR="$WORK/state"

mkdir -p "$WDIR" "$ISS_DATA" "$RCP_DATA" "$STATE_DIR"

c_blue() { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()  { printf '\033[1;31m%s\033[0m\n' "$*"; }
die()    { c_red "ERROR: $*"; exit 1; }

# ---- wallet creation (idempotent) -------------------------------------------
create_wallet() {
  local name="$1" data="$2"
  if [ -f "$WDIR/$name.derive" ] && "${RGB[@]}" -d "$data" list 2>/dev/null | grep -q "$name"; then
    return 0
  fi
  c_blue "creating wallet '$name'"
  "${BPHOT[@]}" seed "$WDIR/$name.seed" </dev/null >/dev/null 2>&1 || die "bp-hot seed ($name)"
  "${BPHOT[@]}" derive -N -s bip86 -a 0h "$WDIR/$name.seed" "$WDIR/$name.derive" </dev/null \
    > "$WDIR/$name.account.txt" 2>/dev/null || die "bp-hot derive ($name)"
  local account
  account="$(awk '/Account:/ {print $NF}' "$WDIR/$name.account.txt")"
  [ -n "$account" ] || die "could not parse account descriptor for $name"
  local desc="$account/<0;1;9;10>/*"
  echo "$desc" > "$WDIR/$name.descriptor"
  "${RGB[@]}" -d "$data" create --tapret-key-only "$desc" "$name" 2>&1 | tail -1
  c_blue "importing NIA schema into '$name'"
  "${RGB[@]}" -d "$data" import -w "$name" "$SCHEMA_NIA" > "$WDIR/$name.schema.txt" 2>&1 || true
}

nia_schema_id() {
  awk '/schema/ {print $NF}' "$WDIR/issuer.schema.txt" 2>/dev/null | grep -E '#|~' | head -1
}

issuer_address() { "${RGB[@]}" -d "$ISS_DATA" address -w issuer 2>/dev/null | awk '/tb1/ {print $NF}' | head -1; }

# first confirmed owned outpoint (txid:vout) for the issuer
issuer_outpoint() {
  "${RGB[@]}" -d "$ISS_DATA" utxos -w issuer --sync 2>/dev/null \
    | grep -oE '[0-9a-f]{64}:[0-9]+' | head -1
}

cmd_setup() {
  create_wallet issuer "$ISS_DATA"
  create_wallet recipient "$RCP_DATA"
  local addr; addr="$(issuer_address)"
  [ -n "$addr" ] || die "could not derive issuer address"
  echo "$addr" > "$WORK/issuer.address"
  echo
  c_grn "Issuer funding address (Mutinynet / signet):"
  echo "    $addr"
  echo
  c_blue "Fund it with a small amount from the Mutinynet faucet (captcha-gated, one click):"
  echo "    $FAUCET_URL   (paste the address above; ~10,000 sats is plenty)"
  echo
  c_blue "Then run:   bash integration/mutinynet-dryrun.sh run"
}

cmd_status() {
  c_blue "syncing issuer wallet against $ESPLORA …"
  "${RGB[@]}" -d "$ISS_DATA" utxos -w issuer --sync 2>&1 | tail -20
  local op; op="$(issuer_outpoint)"
  if [ -n "$op" ]; then c_grn "funded — issuance UTXO available: $op"; else c_red "no confirmed UTXO yet"; fi
}

cmd_run() {
  local op; op="$(issuer_outpoint)"
  [ -n "$op" ] || die "issuer not funded yet (no confirmed UTXO). Run 'setup', fund the address, then 'run'."
  local txid_issue="${op%:*}" vout_issue="${op##*:}"
  c_grn "using issuance UTXO: $txid_issue:$vout_issue"

  # ---- issue the contract (idempotent: reuse an already-issued contract) ----
  local contract_id
  if [ -s "$WORK/contract.id" ]; then
    contract_id="$(cat "$WORK/contract.id")"
    c_grn "reusing already-issued contract: $contract_id"
  else
    local schema_id; schema_id="$(nia_schema_id)"
    [ -n "$schema_id" ] || die "could not determine NIA schema id (re-run setup)"
    c_blue "schema id: $schema_id"
    sed -e "s|schema_id|$schema_id|" \
        -e "s|issued_supply|$ISSUE_SUPPLY|g" \
        -e "s|txid:vout|$txid_issue:$vout_issue|" \
        "$TEMPLATE" > "$CONTRACT_YAML"
    c_blue "issuing contract"
    "${RGB[@]}" -d "$ISS_DATA" issue -w issuer "ssi:issuer" "$CONTRACT_YAML" \
      > "$WORK/issuance.out" 2>&1 || { cat "$WORK/issuance.out"; die "issue failed"; }
    cat "$WORK/issuance.out"
    contract_id="$(grep '^A new contract' "$WORK/issuance.out" | cut -d' ' -f4)"
    [ -n "$contract_id" ] || die "could not parse contract id"
    echo "$contract_id" > "$WORK/contract.id"
    c_grn "contract: $contract_id"
  fi

  # ---- recipient invoice (address/witness mode: no recipient funding needed)
  # Capture stdout to a file (stderr -> log) and extract the rgb:… invoice line;
  # --sync avoids a flaky first-call empty result on a freshly created wallet.
  c_blue "recipient: creating address-based (witness) invoice"
  local invoice
  "${RGB[@]}" -d "$RCP_DATA" invoice --address-based --sync -w recipient \
      --amount "$SEND_AMT" "$contract_id" > "$WORK/invoice.out" 2>"$WORK/invoice.err"
  invoice="$(grep -oE 'rgb:[^[:space:]]+' "$WORK/invoice.out" | head -1)"
  [ -n "$invoice" ] || { cat "$WORK/invoice.err"; die "invoice creation failed"; }
  echo "$invoice" > "$WORK/invoice.txt"
  c_grn "invoice: $invoice"

  # ---- sender: build the RGB transfer (consignment + PSBT) ------------------
  c_blue "sender: preparing RGB transfer (real fee estimation from $ESPLORA)"
  "${RGB[@]}" -d "$ISS_DATA" transfer -w issuer --sats "$SATS" \
      "$invoice" "$CONSIGNMENT" "$PSBT" 2>&1 | tail -8
  [ -f "$CONSIGNMENT" ] || die "no consignment produced"
  [ -f "$PSBT" ] || die "no PSBT produced"
  c_grn "consignment: $(wc -c < "$CONSIGNMENT") bytes; PSBT: $(wc -c < "$PSBT") bytes"

  # ---- recipient: validate the consignment ---------------------------------
  c_blue "recipient: validating consignment"
  "${RGB[@]}" -d "$RCP_DATA" validate "$CONSIGNMENT" > "$WORK/validate.out" 2>&1 || true
  if grep -q 'is valid' "$WORK/validate.out"; then c_grn "consignment VALID"; else cat "$WORK/validate.out"; die "validation failed"; fi

  # ---- sender: sign + finalize + broadcast ---------------------------------
  c_blue "sender: signing PSBT"
  "${BPHOT[@]}" sign -N "$PSBT" "$WDIR/issuer.derive" </dev/null > "$WORK/sign.out" 2>&1 || true
  grep -qE 'Done [1-9].*signature' "$WORK/sign.out" || { cat "$WORK/sign.out"; die "signing failed"; }
  c_grn "signed"
  c_blue "sender: finalizing + broadcasting via $ESPLORA"
  "${RGB[@]}" finalize -p "--esplora=$ESPLORA" -n "$NETWORK" -d "$ISS_DATA" -w issuer \
      "$PSBT" "$TXFILE" > "$WORK/finalize.out" 2>&1 || { cat "$WORK/finalize.out"; die "finalize/broadcast failed"; }
  cat "$WORK/finalize.out"

  # ---- recover the witness txid --------------------------------------------
  # `finalize -p` does not print the txid, so ask the indexer what spent our
  # issuance UTXO: the witness tx is exactly the tx that spends it.
  local txid
  txid="$(curl -s -m 15 "$ESPLORA/tx/$txid_issue/outspend/$vout_issue" \
            | grep -oE '"txid":"[0-9a-f]{64}"' | head -1 | cut -d'"' -f4)"
  echo "${txid:-unknown}" > "$WORK/txid"

  # ---- recipient: accept ----------------------------------------------------
  c_blue "recipient: accepting transfer into stash"
  "${RGB[@]}" -d "$RCP_DATA" accept -w recipient "$CONSIGNMENT" > "$WORK/accept.out" 2>&1 || true
  grep -q 'accepted into the stash' "$WORK/accept.out" && c_grn "accepted" || { c_red "accept not confirmed (tx may be unconfirmed; re-run accept after a block)"; }

  echo
  c_grn "================= DRY-RUN ARTIFACTS ================="
  echo "RGB contract id : $contract_id"
  echo "Bitcoin txid    : ${txid:-<see finalize.out>}"
  [ -n "${txid:-}" ] && echo "Explorer link   : $EXPLORER_TX/$txid"
  echo "Consignment     : $CONSIGNMENT ($(wc -c < "$CONSIGNMENT") bytes)"
  c_grn "===================================================="
}

case "${1:-auto}" in
  setup)  cmd_setup ;;
  status) cmd_status ;;
  run)    cmd_run ;;
  auto)
    cmd_setup
    if [ -n "$(issuer_outpoint)" ]; then cmd_run; else
      echo; c_red "Not funded yet — fund the address above, then: bash integration/mutinynet-dryrun.sh run"
    fi ;;
  *) die "unknown command: $1 (use: setup | status | run)" ;;
esac
