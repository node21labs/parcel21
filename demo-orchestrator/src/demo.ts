/**
 * One demo run = one real RGB asset transfer delivered over the Parcel21 relay on public Mutinynet.
 *
 * Order follows the real RGB/Parcel21 flow: the payer builds the transfer, hands the consignment to
 * the payee over Nostr, the payee validates and ACKs, and ONLY THEN does the payer broadcast the
 * Bitcoin witness tx — so the on-chain tx never fires on an unvalidated/forged ACK.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from './config.ts'
import {
  statePath,
  makeInvoice,
  buildTransfer,
  validateConsignment,
  signAndBroadcast,
  acceptTransfer,
  type DemoState,
} from './rgb.ts'
import { deliverOverRelay } from './relay.ts'

export interface ProgressEvent {
  step: string
  status: 'running' | 'ok' | 'error'
  data?: Record<string, unknown>
}

export interface DemoArtifacts {
  contractId: string
  contract: { ticker: string; name: string; supply: number }
  sendAmount: number
  consignmentBytes: number
  consignmentSha256: string
  nostrEventId: string
  nevent: string
  nostrGuruUrl: string
  njumpUrl: string
  bitcoinTxid: string
  explorerUrl: string
  accepted: boolean
}

function loadState(): DemoState {
  if (!existsSync(statePath())) throw new Error('demo contract not bootstrapped yet')
  return JSON.parse(readFileSync(statePath(), 'utf8')) as DemoState
}

export async function runDemo(runId: string, onPhase: (e: ProgressEvent) => void): Promise<DemoArtifacts> {
  const state = loadState()
  const runDir = resolve(config.dataDir, 'runs', runId)

  // 1. recipient invoice (witness mode)
  onPhase({ step: 'invoice', status: 'running' })
  const invoice = await makeInvoice(state.contractId)
  onPhase({ step: 'invoice', status: 'ok', data: { invoice } })

  // 2. sender builds the RGB transfer (real fee estimation from the public indexer)
  onPhase({ step: 'transfer', status: 'running' })
  const { consignmentBytes, psbtPath } = await buildTransfer(invoice, runDir)
  onPhase({ step: 'transfer', status: 'ok', data: { bytes: consignmentBytes.length } })

  // 3. deliver over the relay → receive → validate → authenticated ACK (steps emitted inside)
  const deliveredPath = resolve(runDir, 'received.rgb')
  const { nevent, eventId, sha256 } = await deliverOverRelay({
    consignmentBytes,
    deliveredPath,
    validate: validateConsignment,
    onPhase,
  })

  // 4. broadcast the Bitcoin witness tx (only now — after a verified ACK)
  onPhase({ step: 'broadcast', status: 'running' })
  const bitcoinTxid = await signAndBroadcast(psbtPath, runDir)
  const explorerUrl = `${config.explorerTx}/${bitcoinTxid}`
  onPhase({ step: 'broadcast', status: 'ok', data: { txid: bitcoinTxid, explorerUrl } })

  // 5. recipient accepts into its stash (best-effort; may be pending until 1 conf)
  onPhase({ step: 'accept', status: 'running' })
  const accepted = await acceptTransfer(deliveredPath)
  onPhase({ step: 'accept', status: accepted ? 'ok' : 'error' })

  return {
    contractId: state.contractId,
    contract: { ticker: state.ticker, name: state.name, supply: state.supply },
    sendAmount: config.sendAmount,
    consignmentBytes: consignmentBytes.length,
    consignmentSha256: sha256,
    nostrEventId: eventId,
    nevent,
    nostrGuruUrl: `${config.nostrGuru}/${nevent}`,
    njumpUrl: `${config.njump}/${nevent}`,
    bitcoinTxid,
    explorerUrl,
    accepted,
  }
}
