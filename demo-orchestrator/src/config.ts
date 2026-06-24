/**
 * Demo-orchestrator configuration. All runtime knobs come from the environment so the same image
 * runs locally (binaries at absolute paths) and on Railway (binaries on PATH, /data volume).
 *
 * Network note: Mutinynet is a custom signet — rgb-cmd treats it as standard signet, so NETWORK is
 * always `signet` and only the ESPLORA/EXPLORER/FAUCET URLs change to switch to standard signet.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, '..')

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const config = {
  port: Number(env('PORT', '8080')),

  // wallet/stash state — persisted on a Railway volume in production
  dataDir: env('DATA_DIR', resolve(pkgRoot, 'data')),

  // native binaries (on PATH in the container; absolute paths for local dev via env)
  rgbBin: env('RGB_BIN', 'rgb'),
  bpHotBin: env('BP_HOT_BIN', 'bp-hot'),

  // bundled RGB assets (NIA schema + contract template)
  schemaNia: resolve(pkgRoot, 'assets/NonInflatableAsset.rgb'),
  contractTemplate: resolve(pkgRoot, 'assets/parcel21-demo.yaml.template'),

  // chain / indexer (Mutinynet defaults; swap these three for standard signet).
  // `network` is what rgb-cmd runs on (it only accepts `-n signet`; Mutinynet IS a custom signet).
  // `networkLabel` is the human name shown in the UI, derived from the indexer so it tracks the URLs.
  network: env('BITCOIN_NETWORK', 'signet'),
  networkLabel: env('NETWORK_LABEL', /mutinynet/i.test(env('ESPLORA_SERVER', 'https://mutinynet.com/api')) ? 'Mutinynet' : 'signet'),
  esplora: env('ESPLORA_SERVER', 'https://mutinynet.com/api'),
  explorerTx: env('EXPLORER_TX_BASE', 'https://mutinynet.com/tx'),
  faucetUrl: env('FAUCET_URL', 'https://faucet.mutinynet.com'),

  // Nostr relay the gift-wrapped consignment really transits
  relay: env('PARCEL21_RELAY', 'wss://relay-production-1664.up.railway.app'),
  // gateways that render a kind-1059 nevent for anonymous viewers
  nostrGuru: env('NOSTR_GURU_BASE', 'https://nostr.guru'),
  njump: env('NJUMP_BASE', 'https://njump.me'),

  // seed password for bp-hot (secret in production)
  seedPassword: env('SEED_PASSWORD', 'parcel21 demo seed'),

  // contract + transfer economics
  issuerWallet: 'issuer',
  recipientWallet: 'recipient',
  ticker: env('DEMO_TICKER', 'USDT'),
  issueSupply: Number(env('ISSUE_SUPPLY', '2000')),
  sendAmount: Number(env('SEND_AMOUNT', '1')), // RGB units transferred per click
  witnessSats: Number(env('WITNESS_SATS', '1000')), // sats placed in the recipient witness output
  lowBalanceSats: Number(env('LOW_BALANCE_SATS', '5000')), // warn/refill threshold

  // run-queue guards
  runTimeoutMs: Number(env('RUN_TIMEOUT_MS', '180000')),
}

export type Config = typeof config
