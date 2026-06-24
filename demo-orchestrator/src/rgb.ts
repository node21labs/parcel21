/**
 * Thin async wrappers around the native `rgb` (rgb-cmd) and `bp-hot` (bp-wallet) binaries, plus the
 * persistent issuer/recipient wallet bootstrap. Every invocation here mirrors the sequence proven
 * end-to-end on public Mutinynet in integration/mutinynet-dryrun.sh and PROOF-mutinynet.md.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Transaction } from 'bitcoinjs-lib'
import { config } from './config.ts'

const exec = promisify(execFile)
const MAXBUF = 32 * 1024 * 1024

const issuerData = () => resolve(config.dataDir, 'data_issuer')
const recipientData = () => resolve(config.dataDir, 'data_recipient')
const walletsDir = () => resolve(config.dataDir, 'wallets')
export const statePath = () => resolve(config.dataDir, 'state.json')

/** Common rgb prefix: network + esplora indexer, on every call (rgb-cmd is daemonless). */
function rgbArgs(dataDir: string, rest: string[]): string[] {
  return ['-n', config.network, `--esplora=${config.esplora}`, '-d', dataDir, ...rest]
}

async function rgb(dataDir: string, rest: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec(config.rgbBin, rgbArgs(dataDir, rest), { encoding: 'utf8', maxBuffer: MAXBUF })
}

async function bpHot(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec(config.bpHotBin, args, {
    encoding: 'utf8',
    maxBuffer: MAXBUF,
    env: { ...process.env, SEED_PASSWORD: config.seedPassword },
  })
}

// ── wallet creation ──────────────────────────────────────────────────────────
async function ensureWallet(name: string, dataDir: string): Promise<void> {
  const derive = resolve(walletsDir(), `${name}.derive`)
  if (existsSync(derive)) {
    try {
      const { stdout } = await rgb(dataDir, ['list'])
      if (stdout.includes(name)) return
    } catch {
      /* fall through and (re)create */
    }
  }
  mkdirSync(walletsDir(), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const seed = resolve(walletsDir(), `${name}.seed`)
  await bpHot(['seed', seed])
  const { stdout: deriveOut } = await bpHot(['derive', '-N', '-s', 'bip86', '-a', '0h', seed, derive])
  const account = deriveOut.split('\n').find((l) => l.includes('Account:'))?.trim().split(/\s+/).pop()
  if (!account) throw new Error(`could not parse account descriptor for ${name}`)
  const descriptor = `${account}/<0;1;9;10>/*`
  writeFileSync(resolve(walletsDir(), `${name}.descriptor`), descriptor)
  await rgb(dataDir, ['create', '--tapret-key-only', descriptor, name])
  await rgb(dataDir, ['import', '-w', name, config.schemaNia])
}

// ── wallet queries ───────────────────────────────────────────────────────────
export async function issuerAddress(): Promise<string> {
  // Fixed index 0 so the funding address is STABLE across calls (a bare `rgb address` shifts the
  // index each call). Funds to index 0 are still detected by `utxos --sync`.
  const { stdout } = await rgb(issuerData(), ['address', '-i', '0', '-w', config.issuerWallet])
  const addr = stdout.split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '').find((t) => /^(tb1|bcrt1|bc1)/.test(t))
  if (!addr) throw new Error('could not derive issuer address')
  return addr
}

/** Sync the issuer wallet and return its total spendable sats + first outpoint (txid:vout). */
export async function issuerFunds(): Promise<{ totalSats: number; outpoint: string | null }> {
  const { stdout } = await rgb(issuerData(), ['utxos', '-w', config.issuerWallet, '--sync'])
  const outpoint = stdout.match(/[0-9a-f]{64}:\d+/)?.[0] ?? null
  const total = stdout.match(/total balance:\s*([0-9]+)/i)
  let totalSats = total ? Number(total[1]) : 0
  if (!totalSats) {
    // fall back to summing the amount column of the utxo listing
    for (const m of stdout.matchAll(/^\s*\S+\s+([0-9]+)\s+[0-9a-f]{64}:\d+/gm)) totalSats += Number(m[1])
  }
  return { totalSats, outpoint }
}

const NIA_SCHEMA_ID = 'RWhwUfTMpuP2Zfx1~j4nswCANGeJrYOqDcKelaMV4zU#remote-digital-pegasus'

// ── bootstrap ────────────────────────────────────────────────────────────────
export interface DemoState {
  contractId: string
  ticker: string
  name: string
  supply: number
}

export interface BootstrapResult {
  ready: boolean
  state?: DemoState
  fundingAddress?: string
  totalSats: number
  reason?: string
}

/**
 * Make sure both wallets exist and a demo contract is issued. Issuance needs a funded issuer UTXO;
 * if the issuer has no coins yet, returns `ready:false` with the address to fund (one-time seed).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  mkdirSync(config.dataDir, { recursive: true })
  await ensureWallet(config.issuerWallet, issuerData())
  await ensureWallet(config.recipientWallet, recipientData())

  if (existsSync(statePath())) {
    const state = JSON.parse(readFileSync(statePath(), 'utf8')) as DemoState
    const { totalSats } = await issuerFunds()
    return { ready: true, state, totalSats }
  }

  const { totalSats, outpoint } = await issuerFunds()
  if (!outpoint) {
    return { ready: false, fundingAddress: await issuerAddress(), totalSats, reason: 'issuer wallet not funded yet' }
  }

  // issue the demo contract against the funded UTXO
  const tmpl = readFileSync(config.contractTemplate, 'utf8')
  const yaml = tmpl
    .replace('schema_id', NIA_SCHEMA_ID)
    .replaceAll('issued_supply', String(config.issueSupply))
    .replace('txid:vout', outpoint)
  const yamlPath = resolve(config.dataDir, 'contract.yaml')
  writeFileSync(yamlPath, yaml)
  const { stdout, stderr } = await rgb(issuerData(), ['issue', '-w', config.issuerWallet, `ssi:${config.issuerWallet}`, yamlPath])
  const line = `${stdout}\n${stderr}`.split('\n').find((l) => l.startsWith('A new contract'))
  const contractId = line?.split(/\s+/)[3]
  if (!contractId) throw new Error(`could not parse contract id from issuance:\n${stdout}\n${stderr}`)
  const state: DemoState = { contractId, ticker: config.ticker, name: 'USD Tether', supply: config.issueSupply }
  writeFileSync(statePath(), JSON.stringify(state, null, 2))
  return { ready: true, state, totalSats }
}

// ── per-run RGB steps ─────────────────────────────────────────────────────────
/** Recipient creates an address-based (witness) invoice — no recipient pre-funding required. */
export async function makeInvoice(contractId: string): Promise<string> {
  // No --sync here: it forces a full wallet rescan that can hang against a public Esplora, and the
  // recipient wallet's cached state is fine (it was synced at bootstrap). Proven in the dry-run.
  const { stdout } = await rgb(recipientData(), [
    'invoice', '--address-based', '-w', config.recipientWallet, '--amount', String(config.sendAmount), contractId,
  ])
  const invoice = stdout.match(/rgb:[^\s]+/)?.[0]
  if (!invoice) throw new Error('invoice creation produced no rgb: invoice')
  return invoice
}

/** Sender builds the RGB transfer: a real consignment + a PSBT (fees estimated from the indexer). */
export async function buildTransfer(invoice: string, runDir: string): Promise<{ consignmentPath: string; psbtPath: string; consignmentBytes: Uint8Array }> {
  mkdirSync(runDir, { recursive: true })
  const consignmentPath = resolve(runDir, 'consignment.rgb')
  const psbtPath = resolve(runDir, 'transfer.psbt')
  await rgb(issuerData(), ['transfer', '-w', config.issuerWallet, '--sats', String(config.witnessSats), invoice, consignmentPath, psbtPath])
  if (!existsSync(consignmentPath) || !existsSync(psbtPath)) throw new Error('rgb transfer did not produce consignment/psbt')
  return { consignmentPath, psbtPath, consignmentBytes: new Uint8Array(readFileSync(consignmentPath)) }
}

/** Recipient validates a (relay-delivered) consignment file. */
export async function validateConsignment(path: string): Promise<boolean> {
  const { stdout, stderr } = await rgb(recipientData(), ['validate', path])
  return /is valid/i.test(`${stdout}\n${stderr}`)
}

/** Sign + finalize + broadcast; returns the witness txid (computed from the signed tx). */
export async function signAndBroadcast(psbtPath: string, runDir: string): Promise<string> {
  const derive = resolve(walletsDir(), `${config.issuerWallet}.derive`)
  await bpHot(['sign', '-N', psbtPath, derive])
  const txPath = resolve(runDir, 'transfer.tx')
  const { stdout, stderr } = await rgb(issuerData(), ['finalize', '-p', `--esplora=${config.esplora}`, '-n', config.network, '-d', issuerData(), '-w', config.issuerWallet, psbtPath, txPath])
  const out = `${stdout}\n${stderr}`
  if (!/Publishing transaction.*success/i.test(out)) throw new Error(`broadcast did not report success:\n${out}`)
  if (!existsSync(txPath)) throw new Error('finalize did not write the signed tx')
  return Transaction.fromBuffer(readFileSync(txPath)).getId()
}

/** Recipient accepts the transfer into its stash (best-effort; tx may still be unconfirmed). */
export async function acceptTransfer(path: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await rgb(recipientData(), ['accept', '-w', config.recipientWallet, path])
    return /accepted into the stash/i.test(`${stdout}\n${stderr}`)
  } catch {
    return false
  }
}
