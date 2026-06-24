import type { AddressInfo } from 'node:net'
import { type NaruContext, appRouter } from '@naru/api'
import { type EmbeddingsConfig, type LlmConfig, Naru } from '@naru/core'
import type { RetentionMode } from '@naru/schema'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { generateToken, tokenOk } from './auth'
import { acquireServerOwnership, removeServerFile, writeServerFile } from './discovery'

/** Loopback host the server binds to unless explicitly overridden. */
const DEFAULT_HOST = '127.0.0.1'

/** Only loopback origins may drive the server from a browser context (§15.3). */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** DB path override; ':memory:' for tests. Defaults to plan §23 location. */
  db?: string
  /** Bind host; defaults to loopback. Non-loopback is allowed but warned. */
  host?: string
  /** Bind port; `0` (default) picks an ephemeral port resolved on listen. */
  port?: number
  /** Episode retention mode override; defaults to core's `redacted`. */
  retentionMode?: RetentionMode
  /**
   * Optional LLM extractor configuration (plan §6.2, §13.2). Flows into
   * {@link Naru.open} so the server-owned facade can run extraction-driven
   * capture. When unset (or `provider: 'none'`) extraction stays unavailable
   * and `memory.capture` falls back to a single manual fact (plan §13.3).
   */
  llm?: LlmConfig
  /**
   * Optional embeddings configuration (plan §6.2, §11.9, M3). Flows into
   * {@link Naru.open} so the server-owned facade computes/serves fact vectors and
   * `system.status` reports the vector backend + embedder. When unset (or
   * `provider: 'none'`) vector retrieval is OFF and search/`context.build`
   * degrade to BM25/entity/recency (plan §6.2).
   */
  embeddings?: EmbeddingsConfig
}

/** Live handle returned by {@link createServer}. */
export interface ServerHandle {
  /** Base URL clients connect to (e.g. `http://127.0.0.1:53412`). */
  url: string
  /** Resolved bind host. */
  host: string
  /** Resolved listening port. */
  port: number
  /** Bearer token required on every non-health request — do NOT log this. */
  token: string
  /** Stop the server, remove the discovery file, and close the store. */
  close(): Promise<void>
}

/**
 * Serialized single-writer queue (plan §12.3).
 *
 * The server is the single logical writer for its DB, so every WRITE runs
 * through one promise chain — at most one write executes at a time, in
 * submission order. Reads never enter the queue (WAL allows concurrent
 * readers). This is the seam the async extraction pipeline (M2-A) plugs into:
 * episode capture / extraction / linking become enqueued tasks without
 * changing callers.
 */
class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Enqueue `task`; resolves with its result after all prior writes settle. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    // Keep the chain alive even if a task rejects, so one failed write does not
    // wedge the queue for every subsequent writer.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * The {@link Naru} facade methods that mutate persistent state. Calls to these
 * are routed through the {@link WriteQueue}; everything else bypasses it. Kept
 * as an explicit allow-list (vs. guessing by name) so the single-writer
 * guarantee is auditable and a new read method never accidentally serializes.
 */
const WRITE_METHODS = new Set<keyof Naru>([
  'ensureScope',
  'addMemory',
  'capture',
  'forget',
  'supersede',
  'captureEpisode',
  'reindex',
])

/**
 * Wrap a {@link Naru} so its write methods are serialized through `queue` while
 * reads call straight through. Write methods return a Promise (the queue is
 * async); tRPC mutations already `await` their return value, so the router is
 * unchanged. Read methods stay synchronous.
 */
function withWriteQueue(naru: Naru, queue: WriteQueue): Naru {
  return new Proxy(naru, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') {
        return value
      }
      const fn = value as (...args: unknown[]) => unknown
      if (WRITE_METHODS.has(prop as keyof Naru)) {
        return (...args: unknown[]) => queue.run(() => fn.apply(target, args))
      }
      return (...args: unknown[]) => fn.apply(target, args)
    },
  }) as Naru
}

/**
 * Connect-style middleware: serve unauthenticated `GET /health`, reject
 * cross-origin and non-loopback `Host` requests (DNS-rebinding/CSRF defense,
 * §15.3), then hand off to the tRPC handler. Returning without calling `next`
 * after writing a response ends the request.
 */
function buildMiddleware() {
  return (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: (err?: unknown) => void,
  ): void => {
    // (1) Unauthenticated health probe.
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // (2) Reject any non-loopback Origin (browsers always send Origin on
    // cross-origin requests; same-origin/non-browser callers may omit it).
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && !LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden origin' }))
      return
    }
    // (3) Validate the Host header resolves to loopback (defends rebinding).
    // A MISSING/empty Host is itself an unexpected-host case (trivial over a raw
    // socket / HTTP/1.0) and is rejected — every HTTP/1.1 client, including the
    // CLI's tRPC httpBatchLink, always sends Host, so legitimate traffic is
    // unaffected (§15.3).
    const host = req.headers.host
    const hostname =
      typeof host === 'string' ? host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') : ''
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden host' }))
      return
    }
    next()
  }
}

/**
 * Open the single logical writer and start the secured local tRPC server.
 *
 * Binds loopback only by default, generates a per-start auth token, serializes
 * writes through a {@link WriteQueue}, and publishes a `0600` discovery file
 * next to the DB. Refuses to start if a LIVE server already owns the DB;
 * overwrites a STALE discovery file (dead pid). Returns once listening.
 */
export async function createServer(options: CreateServerOptions = {}): Promise<ServerHandle> {
  const host = options.host ?? DEFAULT_HOST
  if (host !== DEFAULT_HOST && host !== 'localhost') {
    process.stderr.write(
      `[naru-server] WARNING: binding non-loopback host "${host}" exposes memory beyond this machine.\n`,
    )
  }

  // Resolve the canonical DB path the same way the store would, WITHOUT opening
  // the DB yet, so ownership is claimed before any handle is acquired.
  const probe = Naru.open({
    db: options.db,
    retentionMode: options.retentionMode,
    llm: options.llm,
    embeddings: options.embeddings,
  })
  const dbPath = probe.status().dbPath
  probe.close()

  // Atomically claim sole-server ownership of this DB (plan §12.3, §15.3). This
  // collapses the read-then-write TOCTOU: an exclusive-create lock keyed to the
  // DB file means at most one server can ever own it. Throws if a LIVE server
  // already owns it; reclaims a stale (dead-pid) lock.
  const ownership = acquireServerOwnership(dbPath)

  let naru: Naru
  try {
    naru = Naru.open({
      db: options.db,
      retentionMode: options.retentionMode,
      llm: options.llm,
      embeddings: options.embeddings,
    })
  } catch (err) {
    ownership.release()
    throw err
  }

  const token = generateToken()
  const queue = new WriteQueue()
  const guardedNaru = withWriteQueue(naru, queue)

  const server = createHTTPServer({
    router: appRouter,
    middleware: buildMiddleware(),
    createContext: ({ req }): NaruContext => ({
      naru: guardedNaru,
      authed: tokenOk(req.headers.authorization, token),
    }),
    onError({ error }) {
      // Surface server-side faults without leaking the token; tRPC already maps
      // UNAUTHORIZED/NOT_FOUND/etc. to client responses.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        process.stderr.write(`[naru-server] internal error: ${error.message}\n`)
      }
    },
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (err) {
    // listen failed (e.g. EADDRINUSE on an explicit --port): release every
    // resource we acquired so no DB handle or ownership lock leaks (§ review).
    naru.close()
    ownership.release()
    throw err
  }

  const port = (server.address() as AddressInfo).port
  writeServerFile({ dbPath, host, port, token, pid: process.pid })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    // Only remove the discovery file if it is still ours (pid + token), then
    // release ownership and close the store.
    removeServerFile(dbPath, { pid: process.pid, token })
    ownership.release()
    naru.close()
  }

  return { url: `http://${host}:${port}`, host, port, token, close }
}
