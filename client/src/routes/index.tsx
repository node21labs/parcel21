import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Play, RotateCcw, Send, Inbox, ShieldCheck, Server } from 'lucide-react'
import { getPool } from '../lib/relay'
import { postConsignment, subscribeInbound, postAck, subscribeAck } from '../lib/parcel21'
import { randomRecipientId, randomTxid } from '../lib/invoice'
import { useIdentity, useRelay, useLog } from '../lib/hooks'
import { Button, Card, LogPanel, Mono, StatusPill } from '../components/ui'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { identity, nip07, regenerate } = useIdentity()
  const [relay, setRelay] = useRelay()
  const { lines, push, clear } = useLog()
  const [demoState, setDemoState] = useState<'idle' | 'pending' | 'ACK' | 'NACK'>('idle')
  const [running, setRunning] = useState(false)

  async function runQuickDemo() {
    setRunning(true)
    setDemoState('pending')
    clear()
    push(`relay ${relay}`)
    const pool = getPool()
    const payeeSk = generateSecretKey()
    const payeePub = getPublicKey(payeeSk)
    const recipient_id = randomRecipientId()
    let inboundSub: { close: () => void } | undefined
    let ackSub: { close: () => void } | undefined
    let settled = false
    const cleanup = () => {
      settled = true
      inboundSub?.close()
      ackSub?.close()
      setRunning(false)
    }

    inboundSub = subscribeInbound(pool, [relay], payeeSk, payeePub, (c) => {
      if (c.payload.recipient_id !== recipient_id) return
      push(`payee  ← received consignment (author ${c.author.slice(0, 12)}…, ${c.payload.mode})`)
      void postAck(pool, {
        relays: [relay],
        payeeSk,
        replyToPub: c.payload.reply_to,
        recipient_id,
        consignment_sha256: c.payload.sha256,
        ack: true,
      }).then(() => push('payee  → posted ACK'))
    })

    try {
      const bytes = new TextEncoder().encode(`demo consignment ${new Date().toISOString()}`)
      const res = await postConsignment(pool, {
        endpoint: { payeePubHex: payeePub, relays: [relay] },
        recipient_id,
        txid: randomTxid(),
        consignmentBytes: bytes,
      })
      push(`payer  → posted consignment (sha256 ${res.sha256.slice(0, 12)}…)`)
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
          push(`payer  ← received ${state} (authenticated) ✓`)
          setDemoState(state)
          cleanup()
        },
      )
      setTimeout(() => {
        if (!settled) {
          push('timed out waiting for ACK — is the relay running?')
          setDemoState('idle')
          cleanup()
        }
      }, 12000)
    } catch (e) {
      push(`error: ${(e as Error).message}`)
      setDemoState('idle')
      cleanup()
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">
          Decentralized RGB consignment exchange over Nostr
        </h1>
        <p className="max-w-2xl text-slate-400">
          Parcel21 replaces the centralized RGB proxy server with encrypted, gift-wrapped Nostr
          events. A sender delivers a consignment; the receiver validates it and returns an ACK — and
          the relay can read neither the contents nor who is talking to whom.
        </p>
        <div className="flex gap-2">
          <Link to="/send">
            <Button>
              <span className="flex items-center gap-2">
                <Send className="size-4" /> Send a consignment
              </span>
            </Button>
          </Link>
          <Link to="/receive">
            <Button variant="ghost">
              <span className="flex items-center gap-2">
                <Inbox className="size-4" /> Receive
              </span>
            </Button>
          </Link>
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> Your identity</span>}>
          {identity ? (
            <div className="space-y-2">
              <div>
                <Mono>{identity.npub}</Mono>
              </div>
              <p className="text-xs text-slate-500">
                {nip07
                  ? 'A NIP-07 extension was detected (signing still uses the in-app key this build).'
                  : 'In-app key, stored in your browser. No extension detected.'}
              </p>
              <Button variant="ghost" onClick={regenerate}>
                <span className="flex items-center gap-2">
                  <RotateCcw className="size-3.5" /> New identity
                </span>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><Server className="size-4" /> Relay</span>}>
          <label className="block text-xs text-slate-500">WebSocket URL</label>
          <input
            value={relay}
            onChange={(e) => setRelay(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
            placeholder="ws://127.0.0.1:7777"
          />
          <p className="mt-2 text-xs text-slate-500">
            Run the reference relay locally: <Mono>docker compose up --build relay</Mono>
          </p>
        </Card>
      </div>

      <Card
        title={
          <span className="flex items-center justify-between">
            <span>Live round-trip demo</span>
            <StatusPill state={demoState} />
          </span>
        }
      >
        <p className="mb-3 text-sm text-slate-400">
          Runs the whole protocol in your browser against the relay above: a payer gift-wraps a
          consignment, a payee receives + ACKs it, and the payer authenticates the ACK — using real
          NIP-44 + NIP-59 crypto with simulated consignment bytes.
        </p>
        <div className="mb-3">
          <Button id="run-demo" onClick={runQuickDemo} disabled={running || !identity}>
            <span className="flex items-center gap-2">
              <Play className="size-4" /> {running ? 'Running…' : 'Run round-trip'}
            </span>
          </Button>
        </div>
        <LogPanel lines={lines} />
      </Card>
    </div>
  )
}
