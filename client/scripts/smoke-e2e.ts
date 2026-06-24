/**
 * Live end-to-end smoke test against a RUNNING Parcel21 relay.
 * Usage: PARCEL21_RELAY=ws://127.0.0.1:7777 npx tsx scripts/smoke-e2e.ts
 *
 * Exercises the full flow over the real relay:
 *   payee subscribes  ->  payer postConsignment  ->  payee receives + postAck  ->  payer subscribeAck.
 * Exits 0 on a verified ACK round-trip, 1 otherwise.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import {
  postConsignment,
  subscribeInbound,
  postAck,
  subscribeAck,
  type RgbNostrEndpoint,
} from '../src/lib/parcel21'

const RELAY = process.env.PARCEL21_RELAY ?? 'ws://127.0.0.1:7777'
const TIMEOUT_MS = 12_000

async function main(): Promise<void> {
  const pool = new SimplePool()
  const relays = [RELAY]

  // payee identity (advertised in the invoice)
  const payeeSk = generateSecretKey()
  const payeePub = getPublicKey(payeeSk)
  const endpoint: RgbNostrEndpoint = { payeePubHex: payeePub, relays }

  const recipient_id = 'txob1smoketest' + getPublicKey(generateSecretKey()).slice(0, 12)
  const txid = 'a'.repeat(64)
  const consignmentBytes = new TextEncoder().encode('fake-but-inline RGB consignment bytes')

  console.log(`relay        : ${RELAY}`)
  console.log(`payee npub   : ${payeePub.slice(0, 16)}…`)
  console.log(`recipient_id : ${recipient_id}`)

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ACK round-trip')), TIMEOUT_MS)

    // PAYEE: receive the consignment, then ACK it.
    const inboundSub = subscribeInbound(pool, relays, payeeSk, payeePub, (c) => {
      if (c.payload.recipient_id !== recipient_id) return
      console.log(`payee  ✓ received consignment (author ${c.author.slice(0, 12)}…, mode=${c.payload.mode})`)
      void postAck(pool, {
        relays,
        payeeSk,
        replyToPub: c.payload.reply_to,
        recipient_id,
        consignment_sha256: c.payload.sha256,
        ack: true,
      }).then(() => console.log('payee  ✓ posted ACK'))
    })

    // PAYER: post the consignment, then wait for the ACK.
    void postConsignment(pool, { endpoint, recipient_id, txid, consignmentBytes }).then((res) => {
      console.log(`payer  ✓ posted consignment (sha256 ${res.sha256.slice(0, 12)}…, reply_to ${res.replyToPub.slice(0, 12)}…)`)
      const ackSub = subscribeAck(
        pool,
        {
          relays,
          replyToSk: res.replyToSk,
          replyToPub: res.replyToPub,
          expectedPayeePubHex: payeePub,
          expectedConsignmentSha256: res.sha256,
        },
        (state) => {
          console.log(`payer  ✓ received ${state} (authenticated to payee)`)
          clearTimeout(timer)
          inboundSub.close()
          ackSub.close()
          if (state === 'ACK') resolve()
          else reject(new Error(`unexpected NACK`))
        },
      )
    }).catch(reject)
  })

  try {
    await done
    console.log('\nPASS: end-to-end ACK round-trip succeeded through the live relay')
  } finally {
    pool.close(relays)
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nFAIL: smoke test failed:', err.message)
    process.exit(1)
  },
)
