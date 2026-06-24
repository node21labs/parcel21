/**
 * Standalone verification of the Parcel21 protocol library's security-critical path.
 * Run: npx tsx scripts/verify-protocol.ts
 *
 * Proves:
 *  1. A legitimately gift-wrapped consignment round-trips and authenticates to the payer's
 *     ephemeral seal key.
 *  2. A legitimate ACK round-trips and authenticates to the payee's identity key.
 *  3. verifiedUnwrap REJECTS a forged rumor whose pubkey != the seal signer (the blocker the
 *     adversarial review caught: nostr-tools unwrapEvent would accept this).
 */

import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent } from 'nostr-tools/pure'
import { wrapEvent, createWrap } from 'nostr-tools/nip59'
import { Seal } from 'nostr-tools/kinds'
import * as nip44 from 'nostr-tools/nip44'
import {
  verifiedUnwrap,
  CONSIGNMENT_KIND,
  ACK_KIND,
  type ConsignmentPayload,
  type AckPayload,
} from '../src/lib/parcel21'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// keys
const payeeSk = generateSecretKey()
const payeePub = getPublicKey(payeeSk)
const payerSealSk = generateSecretKey() // ephemeral, per transfer
const payerSealPub = getPublicKey(payerSealSk)
const replyToSk = generateSecretKey()
const replyToPub = getPublicKey(replyToSk)

console.log('Parcel21 protocol verification')

// 1. consignment round-trip (payer -> payee)
check('legit consignment authenticates to payer ephemeral seal key', () => {
  const payload: ConsignmentPayload = {
    recipient_id: 'txob1testrecipient',
    txid: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    reply_to: replyToPub,
    mode: 'inline',
    consignment_b64: 'Y29uc2lnbm1lbnQ=',
  }
  const wrap = wrapEvent(
    { kind: CONSIGNMENT_KIND, created_at: 1700000000, tags: [], content: JSON.stringify(payload) },
    payerSealSk,
    payeePub,
  )
  const { rumor, author } = verifiedUnwrap(wrap, payeeSk)
  assert.equal(author, payerSealPub, 'author must be the payer seal key')
  assert.equal(rumor.kind, CONSIGNMENT_KIND)
  const got = JSON.parse(rumor.content) as ConsignmentPayload
  assert.equal(got.recipient_id, payload.recipient_id)
  assert.equal(got.reply_to, replyToPub)
})

// 2. ack round-trip (payee -> payer reply mailbox)
check('legit ACK authenticates to payee identity key', () => {
  const ack: AckPayload = { recipient_id: 'txob1testrecipient', ack: true, consignment_sha256: 'b'.repeat(64) }
  const wrap = wrapEvent(
    { kind: ACK_KIND, created_at: 1700000001, tags: [], content: JSON.stringify(ack) },
    payeeSk,
    replyToPub,
  )
  const { rumor, author } = verifiedUnwrap(wrap, replyToSk)
  assert.equal(author, payeePub, 'ACK author must be the payee identity key')
  const got = JSON.parse(rumor.content) as AckPayload
  assert.equal(got.ack, true)
})

// 3. forgery: attacker signs the seal but claims a different rumor.pubkey
check('forged ACK (rumor.pubkey != seal signer) is REJECTED', () => {
  const attackerSk = generateSecretKey()
  const victimPub = payeePub // attacker tries to pass off the ACK as the payee's
  // unsigned rumor claiming to be the victim
  const rumorNoId = { kind: ACK_KIND, created_at: 1700000002, tags: [] as string[][], content: JSON.stringify({ recipient_id: 'x', ack: true, consignment_sha256: 'b'.repeat(64) }), pubkey: victimPub }
  const rumor = { ...rumorNoId, id: getEventHash(rumorNoId) }
  // seal signed by ATTACKER, encrypting the forged rumor, addressed to the payer mailbox
  const sealContent = nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(attackerSk, replyToPub))
  const seal = finalizeEvent({ kind: Seal, created_at: 1700000002, tags: [], content: sealContent }, attackerSk)
  const wrap = createWrap(seal, replyToPub)
  assert.throws(() => verifiedUnwrap(wrap, replyToSk), /impersonation/, 'must reject pubkey/seal mismatch')
})

console.log(`\n${passed}/3 checks passed`)
