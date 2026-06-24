/**
 * Parcel21 ↔ RGB end-to-end harness.
 *
 * Carries a REAL RGB consignment file from a sender to a receiver over Nostr (replacing the
 * rgb-sandbox `cp data0/consignment.rgb data1/`), and runs the REAL `rgb validate` on the
 * receiving side before ACKing. Both parties run in one process (separate keypairs), like the
 * smoke test — the substance is that real consignment bytes travel gift-wrapped through the relay
 * and are validated by the actual RGB CLI.
 *
 * Usage:
 *   npx tsx scripts/rgb-e2e.ts \
 *     --consignment ../../rgb-sandbox/data0/consignment_1.rgb \
 *     --rgb-bin ../../rgb-sandbox/rgb-cmd/bin/rgb \
 *     --rgb-data ../../rgb-sandbox/data1 --wallet rcpt1 \
 *     --indexer localhost:50001 --relay ws://127.0.0.1:7777
 *
 *   # transport-only check (no RGB CLI needed):
 *   npx tsx scripts/rgb-e2e.ts --consignment <file> --no-validate
 *
 * Exit 0 iff the real consignment was delivered, written, (optionally) validated, and ACKed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import {
  postConsignment,
  subscribeInbound,
  postAck,
  subscribeAck,
  sha256hex,
  fromBase64,
  type InboundConsignment,
} from '../src/lib/parcel21'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function log(m: string) {
  console.log(m)
}

async function main() {
  const consignmentPath = arg('consignment')
  if (!consignmentPath) {
    console.error('error: --consignment <path> is required')
    process.exit(2)
  }
  const relay = arg('relay') ?? process.env.PARCEL21_RELAY ?? 'ws://127.0.0.1:7777'
  const rgbBin = arg('rgb-bin') ?? 'rgb'
  const rgbData = arg('rgb-data')
  const wallet = arg('wallet') ?? 'rcpt1'
  const network = arg('network') ?? 'regtest'
  const indexer = arg('indexer') ?? 'localhost:50001'
  const noValidate = flag('no-validate') || !rgbData
  const recvOut = arg('out') ?? (rgbData ? `${rgbData}/parcel21_received.rgb` : './parcel21_received.rgb')

  const bytes = new Uint8Array(readFileSync(consignmentPath))
  log(`relay        : ${relay}`)
  log(`consignment  : ${consignmentPath} (${bytes.length} bytes)`)
  log(`validation   : ${noValidate ? 'skipped' : `${rgbBin} -d ${rgbData} -w ${wallet} validate`}`)
  log('')

  const pool = new SimplePool()
  const payeeSk = generateSecretKey()
  const payeePub = getPublicKey(payeeSk)
  const recipient_id = arg('recipient-id') ?? `utxob1${randomHex(16)}`
  const txid = arg('txid') ?? randomHex(32)

  let inboundSub: { close: () => void } | undefined
  let ackSub: { close: () => void } | undefined
  let settled = false

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        cleanup()
        reject(new Error('timed out waiting for the ACK round-trip'))
      }
    }, 30000)
    function cleanup() {
      settled = true
      clearTimeout(timer)
      inboundSub?.close()
      ackSub?.close()
    }

    async function handleConsignment(c: InboundConsignment) {
      if (c.payload.recipient_id !== recipient_id) return
      log(`payee  ← received consignment (author ${c.author.slice(0, 12)}…, ${c.payload.mode})`)
      if (c.payload.mode !== 'inline' || !c.payload.consignment_b64) {
        log('payee  ! blossom mode not supported by this harness; NACKing')
        await ack(c, false, 'blossom unsupported')
        return
      }
      const received = fromBase64(c.payload.consignment_b64)
      const sha = await sha256hex(received)
      if (sha !== c.payload.sha256) {
        log('payee  ! sha256 mismatch; NACKing')
        await ack(c, false, 'sha256 mismatch')
        return
      }
      writeFileSync(recvOut, received)
      log(`payee  ✓ wrote ${recvOut} (${received.length} bytes, sha256 ${sha.slice(0, 12)}…)`)

      let valid = true
      if (!noValidate) {
        try {
          const out = execFileSync(
            rgbBin,
            ['-n', network, `--electrum=${indexer}`, '-d', rgbData as string, '-w', wallet, 'validate', recvOut],
            { encoding: 'utf8' },
          )
          valid = /is valid/i.test(out)
          log(`payee  rgb validate → ${valid ? 'VALID' : 'NOT VALID'}`)
        } catch (e) {
          valid = false
          log(`payee  rgb validate failed: ${(e as Error).message.split('\n')[0]}`)
        }
      }
      await ack(c, valid, valid ? undefined : 'consignment did not validate')
    }

    async function ack(c: InboundConsignment, ok: boolean, reason?: string) {
      await postAck(pool, {
        relays: [relay],
        payeeSk,
        replyToPub: c.payload.reply_to,
        recipient_id: c.payload.recipient_id,
        consignment_sha256: c.payload.sha256,
        ack: ok,
        reason,
      })
      log(`payee  → posted ${ok ? 'ACK' : 'NACK'}`)
    }

    inboundSub = subscribeInbound(pool, [relay], payeeSk, payeePub, (c) => void handleConsignment(c))

    void postConsignment(pool, {
      endpoint: { payeePubHex: payeePub, relays: [relay] },
      recipient_id,
      txid,
      consignmentBytes: bytes,
    })
      .then((res) => {
        log(`payer  → posted consignment (sha256 ${res.sha256.slice(0, 12)}…)`)
        ackSub = subscribeAck(
          pool,
          {
            relays: [relay],
            replyToSk: res.replyToSk,
            replyToPub: res.replyToPub,
            expectedPayeePubHex: payeePub,
            expectedConsignmentSha256: res.sha256,
          },
          (state) => {
            log(`payer  ← received ${state} (authenticated to payee) ✓`)
            cleanup()
            if (state === 'ACK') resolve()
            else reject(new Error('receiver NACKed the consignment'))
          },
        )
      })
      .catch((e) => {
        cleanup()
        reject(e as Error)
      })
  })

  try {
    await done
    log('\nOK: real RGB consignment delivered, validated and ACKed over Parcel21')
    pool.close([relay])
    process.exit(0)
  } catch (e) {
    console.error(`\nFAILED: ${(e as Error).message}`)
    pool.close([relay])
    process.exit(1)
  }
}

void main()
