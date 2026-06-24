/**
 * Demo-orchestrator HTTP/WS server.
 *
 *   GET  /health              → bootstrap readiness, issuer balance, funding address
 *   POST /run                 → enqueue a demo run (single-concurrency FIFO), returns { jobId }
 *   GET  /run/:id             → final JSON result (or current status)
 *   GET  /run/:id/stream (WS) → live progress events, then the result/error
 *   GET  /last                → the most recent successful run (for the page's example), or 204
 *   GET  /                    → the one-click demo page (public/)
 *
 * A Bitcoin wallet cannot safely build two transfers from the same UTXO set at once, so runs are
 * strictly serialized (concurrency = 1) with a bounded queue + a per-IP cooldown.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { WebSocket } from 'ws'
import { config } from './config.ts'
import { bootstrap, issuerFunds, issuerAddress, syncIssuer, type BootstrapResult } from './rgb.ts'
import { runDemo, type ProgressEvent, type DemoArtifacts } from './demo.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

type JobStatus = 'queued' | 'running' | 'done' | 'error'
interface Job {
  id: string
  status: JobStatus
  events: ProgressEvent[]
  result?: DemoArtifacts
  error?: string
  sockets: Set<WebSocket>
  createdAt: number
}

const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? '5')
const IP_COOLDOWN_MS = Number(process.env.IP_COOLDOWN_MS ?? '6000')

const jobs = new Map<string, Job>()
const queue: string[] = []
const lastRunByIp = new Map<string, number>()
let working = false
let boot: BootstrapResult = { ready: false, totalSats: 0, reason: 'starting' }

// Most recent successful run — persisted so the page can show a real example immediately on load.
const lastResultPath = resolve(config.dataDir, 'last-result.json')
let lastResult: DemoArtifacts | null = null
// Cache the issuer balance so a ready /health doesn't re-sync the wallet on every page load.
let fundsCache: { totalSats: number; outpoint: string | null; at: number } | null = null
const FUNDS_TTL_MS = 60_000

async function refreshFunds(): Promise<void> {
  try {
    const f = await issuerFunds()
    fundsCache = { ...f, at: Date.now() }
  } catch {
    /* keep the stale value */
  }
}

// Non-blocking once ready: serve the cached (or last-known) balance instantly and refresh in the
// background. A wallet sync takes ~20s against the public indexer, so blocking /health on it made
// page-load readiness slow and let concurrent requests pile up.
function fundsForHealth(): { totalSats: number; outpoint: string | null } {
  if (boot.ready && (!fundsCache || Date.now() - fundsCache.at > FUNDS_TTL_MS)) void refreshFunds()
  return fundsCache ?? { totalSats: boot.totalSats, outpoint: null }
}

function emit(job: Job, e: ProgressEvent) {
  job.events.push(e)
  broadcast(job, { type: 'progress', event: e })
}
function broadcast(job: Job, msg: unknown) {
  const s = JSON.stringify(msg)
  for (const ws of job.sockets) {
    try {
      ws.send(s)
    } catch {
      /* ignore */
    }
  }
}

async function pump() {
  if (working) return
  const id = queue.shift()
  if (!id) return
  const job = jobs.get(id)
  if (!job) return void setImmediate(pump)
  working = true
  job.status = 'running'
  emit(job, { step: 'start', status: 'ok' })
  try {
    try {
      job.result = await runDemo(id, (e) => emit(job, e))
    } catch (err) {
      // A stale/already-spent UTXO is the one failure worth retrying: refresh the wallet once and
      // run again. Everything else propagates to the error handler below.
      const m = (err as Error)?.message ?? ''
      if (!/missingorspent|bad-txns|already.{0,3}spent|insufficient/i.test(m)) throw err
      try {
        await syncIssuer()
      } catch {
        /* best effort */
      }
      job.result = await runDemo(id, (e) => emit(job, e))
    }
    job.status = 'done'
    lastResult = job.result
    try {
      writeFileSync(lastResultPath, JSON.stringify(job.result))
    } catch {
      /* non-fatal */
    }
    broadcast(job, { type: 'result', result: job.result })
  } catch (err) {
    job.status = 'error'
    job.error = (err as Error)?.message ?? String(err)
    broadcast(job, { type: 'error', error: job.error })
  } finally {
    working = false
    setImmediate(pump)
  }
}

/** Re-attempt bootstrap if not ready yet (picks up newly-arrived funding without a restart). */
async function ensureBoot(): Promise<BootstrapResult> {
  if (boot.ready) return boot
  try {
    boot = await bootstrap()
  } catch (e) {
    boot = { ready: false, totalSats: 0, reason: (e as Error).message }
  }
  return boot
}

async function main() {
  const app = Fastify({ logger: true })
  await app.register(websocket)
  await app.register(fastifyStatic, { root: resolve(__dirname, '..', 'public'), prefix: '/' })

  app.get('/health', async () => {
    await ensureBoot()
    let funds = { totalSats: boot.totalSats, outpoint: null as string | null }
    let fundingAddress = boot.fundingAddress
    if (boot.ready) {
      funds = fundsForHealth() // instant: cached + background refresh
    } else {
      // pre-funding: sync inline so newly-arrived funding is detected on this call (one-time)
      try {
        funds = await issuerFunds()
        fundsCache = { ...funds, at: Date.now() }
        fundingAddress = await issuerAddress()
      } catch {
        /* ignore */
      }
    }
    return {
      ready: boot.ready,
      reason: boot.reason,
      network: config.network,
      networkLabel: config.networkLabel,
      relay: config.relay,
      explorer: config.explorerTx,
      explorerApi: config.esplora,
      contract: boot.state,
      issuerSats: funds.totalSats,
      lowBalance: funds.totalSats < config.lowBalanceSats,
      fundingAddress: boot.ready ? undefined : fundingAddress,
      queueDepth: queue.length,
      busy: working,
    }
  })

  app.post('/run', async (req, reply) => {
    await ensureBoot()
    if (!boot.ready) {
      return reply.code(503).send({ error: 'demo not ready', reason: boot.reason, fundingAddress: boot.fundingAddress })
    }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
    const now = Date.now()
    const last = lastRunByIp.get(ip) ?? 0
    if (now - last < IP_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'slow down', retryAfterMs: IP_COOLDOWN_MS - (now - last) })
    }
    if (queue.length >= MAX_QUEUE) {
      return reply.code(429).send({ error: 'demo is busy, try again shortly', queueDepth: queue.length })
    }
    lastRunByIp.set(ip, now)
    const id = randomUUID()
    jobs.set(id, { id, status: 'queued', events: [], sockets: new Set(), createdAt: now })
    queue.push(id)
    void pump()
    return reply.code(202).send({ jobId: id, queuePosition: queue.length })
  })

  app.get('/last', async (_req, reply) => {
    if (!lastResult) return reply.code(204).send()
    return lastResult
  })

  app.get<{ Params: { id: string } }>('/run/:id', async (req, reply) => {
    const job = jobs.get(req.params.id)
    if (!job) return reply.code(404).send({ error: 'unknown job' })
    return { id: job.id, status: job.status, result: job.result, error: job.error, events: job.events }
  })

  app.get<{ Params: { id: string } }>('/run/:id/stream', { websocket: true }, (socket, req) => {
    const job = jobs.get((req.params as { id: string }).id)
    if (!job) {
      socket.send(JSON.stringify({ type: 'error', error: 'unknown job' }))
      socket.close()
      return
    }
    // replay buffered progress, then live-stream
    for (const e of job.events) socket.send(JSON.stringify({ type: 'progress', event: e }))
    if (job.status === 'done') socket.send(JSON.stringify({ type: 'result', result: job.result }))
    else if (job.status === 'error') socket.send(JSON.stringify({ type: 'error', error: job.error }))
    job.sockets.add(socket)
    socket.on('close', () => job.sockets.delete(socket))
  })

  if (existsSync(lastResultPath)) {
    try {
      lastResult = JSON.parse(readFileSync(lastResultPath, 'utf8')) as DemoArtifacts
    } catch {
      /* ignore a corrupt cache */
    }
  }

  await ensureBoot()
  await app.listen({ host: '0.0.0.0', port: config.port })
  app.log.info(`parcel21 demo-orchestrator on :${config.port} — ready=${boot.ready} relay=${config.relay}`)
  if (!boot.ready) app.log.warn(`NOT READY: ${boot.reason}; fund issuer at ${boot.fundingAddress ?? '(unknown)'}`)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
