/**
 * REMOTE-ONLY memory client for the OpenCode plugin (real `@opencode-ai/plugin`).
 *
 * OpenCode runs on Bun, where the native `better-sqlite3` will NOT load. The
 * plugin therefore can never operate the store embedded — it must talk to a
 * running `naru serve` over the typed tRPC transport. This module is the
 * adapter's ONLY runtime memory path in OpenCode, and it is deliberately
 * SELF-CONTAINED: it imports nothing that pulls `better-sqlite3`.
 *
 * Allowed imports (CRITICAL — see the package's bundle constraint):
 * - `@trpc/client` (runtime) — the vanilla typed client.
 * - `import type { AppRouter } from "@naru/api"` (TYPE-ONLY, erased at build) —
 *   end-to-end type safety against the server's procedures.
 * - `node:fs` / `node:os` / `node:path` — to read the discovery file directly.
 *
 * It MUST NOT import `@naru/core`, `@naru/store-sqlite`, or the `@naru/server`
 * barrel (all transitively load `better-sqlite3`). The discovery-file shape and
 * default DB path are reproduced here from the server's `discovery.ts` /core's
 * `config.ts` contract rather than imported, precisely to keep the bundle clean.
 *
 * LAZY + GRACEFUL: the tRPC client is not built at construction. The server is
 * resolved and the client memoized on first call. When no server is resolvable
 * or reachable, calls throw a typed {@link NoServerError} the tools/hooks turn
 * into a friendly "start one with `naru serve`" message — the plugin never
 * crashes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppRouter } from '@naru/api'
import { type TRPCClient, createTRPCClient, httpBatchLink } from '@trpc/client'

/**
 * Default on-disk DB location, mirrored from core's `defaultDbPath()` (plan
 * §23): `~/.local/share/naru-memory/naru.db`. Reproduced here (not imported)
 * so this module never pulls `@naru/core` / `better-sqlite3` into the bundle.
 */
function defaultDbPath(): string {
  return join(homedir(), '.local', 'share', 'naru-memory', 'naru.db')
}

/**
 * Discovery file basename for a DB, mirrored from the server's
 * `serverFileName()`: `<dbfile>.naru-server.json`. The default DB
 * `~/.local/share/naru-memory/naru.db` therefore maps to
 * `~/.local/share/naru-memory/naru.db.naru-server.json`.
 */
function discoveryFilePath(dbPath: string): string {
  return `${dbPath}.naru-server.json`
}

/**
 * Parsed contents of a discovery file, mirrored from the server's `ServerFile`
 * (plan §12.3/§15.3). The server writes `{ host, port, token, pid }` next to
 * the DB; we read the half we need to reach it. `pid` is read for parity but the
 * remote client does not perform a liveness check here — an unreachable server
 * surfaces as a {@link NoServerError} on the first request instead.
 */
interface DiscoveryFile {
  host: string
  port: number
  token: string
  pid: number
}

/** Explicit server coordinates passed into {@link createRemoteClient}. */
export interface RemoteServerTarget {
  /** Base URL of a running server, e.g. `http://127.0.0.1:4319`. */
  url: string
  /** Bearer token required on every non-health request (plan §15.3). */
  token: string
}

/** Options for {@link createRemoteClient}. All optional; resolution is lazy. */
export interface RemoteClientOptions {
  /**
   * Explicit server coordinates. When provided, takes precedence over env vars
   * and the discovery file (the highest-priority resolution source).
   */
  server?: RemoteServerTarget
  /**
   * Override the DB path used to locate the discovery file. Defaults to
   * {@link defaultDbPath}. Mainly a test seam (point at a temp discovery file).
   */
  dbPath?: string
  /**
   * Injected env source (defaults to `process.env`). A test seam so resolution
   * from `NARU_SERVER_URL` / `NARU_SERVER_TOKEN` is deterministic.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Injected discovery-file reader (defaults to a `node:fs`-backed reader). A
   * test seam so the discovery path can be stubbed without touching disk.
   */
  readDiscoveryFile?: (dbPath: string) => DiscoveryFile | null
  /**
   * Injected tRPC client factory (defaults to the real `@trpc/client` builder).
   * A test seam so a fake client can be substituted with NO real network.
   */
  createClient?: (resolved: ResolvedServer) => TRPCClient<AppRouter>
}

/** Where a resolved server came from, surfaced for diagnostics. */
export type ServerResolutionSource = 'explicit' | 'env' | 'discovery'

/** A resolved server: its base URL, bearer token, and how it was found. */
export interface ResolvedServer {
  /** Base URL the tRPC client targets (no trailing slash); tRPC appends paths. */
  baseUrl: string
  /** Bearer token attached to every request (plan §15.3). */
  token: string
  /** Which resolution source produced this server. */
  source: ServerResolutionSource
}

/**
 * Typed error thrown when no server can be resolved (or, on a request, when the
 * resolved server is unreachable). The tools/hooks catch this and present a
 * friendly message instead of crashing the plugin. {@link isNoServerError}
 * recognizes it across realms (the `code` brand survives bundling).
 */
export class NoServerError extends Error {
  /** Stable brand so callers can detect it without `instanceof` fragility. */
  readonly code = 'NARU_NO_SERVER' as const

  constructor(message = NO_SERVER_MESSAGE) {
    super(message)
    this.name = 'NoServerError'
  }
}

/** The friendly, user-facing message for a missing/unreachable server. */
export const NO_SERVER_MESSAGE = 'No running Naru server — start one with `naru serve`.'

/** Whether `err` is a {@link NoServerError} (brand check, realm-safe). */
export function isNoServerError(err: unknown): err is NoServerError {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NARU_NO_SERVER'
  )
}

/**
 * The remote memory client surface the tools/hooks consume. Each method maps to
 * an `AppRouter` procedure; argument and result types are INFERRED from the
 * typed tRPC client so they stay in lockstep with the server with no
 * `@naru/core` import. NOT_FOUND from `get` is mapped to `undefined` to match
 * the embedded contract.
 */
export interface RemoteClient {
  /** Hybrid scoped search -> `memory.search.query` (plan §14, §9.4). */
  search(input: MemorySearchInput): Promise<MemorySearchOutput>
  /** Add a manual memory -> `memory.add.mutate` (plan §13.3). */
  addMemory(input: MemoryAddInput): Promise<MemoryAddOutput>
  /** Get one fact with evidence -> `fact.get.query`; `undefined` on NOT_FOUND. */
  get(id: string): Promise<FactGetOutput | undefined>
  /** List facts by scope/status -> `memory.list.query` (plan §15.2). */
  list(input?: MemoryListInput): Promise<MemoryListOutput>
  /** Destructive privacy purge by selector -> `memory.forget.mutate` (plan §18.2). */
  forget(selector: MemoryForgetInput): Promise<MemoryForgetOutput>
  /** Token-bounded prompt context -> `context.build.query` (plan §14.4). */
  buildContext(input: ContextBuildInput): Promise<ContextBuildOutput>
  /** List entities, optionally scoped -> `entity.list.query` (plan §15.2). */
  listEntities(input?: EntityListInput): Promise<EntityListOutput>
  /** Status snapshot -> `system.status.query` (plan §15.2). */
  status(): Promise<SystemStatusOutput>
  /** Capture + extraction-driven ingestion -> `memory.capture.mutate` (plan §13). */
  capture(input: MemoryCaptureInput): Promise<MemoryCaptureOutput>
  /** Get-or-create a scope row -> `scope.resolve.mutate` (plan §11.2). */
  ensureScope(input: ScopeResolveInput): Promise<ScopeResolveOutput>
  /** Resolve the server (lazily) and report how it was found; throws if none. */
  resolveServer(): ResolvedServer
}

/** Typed vanilla tRPC client bound to the resolved server. */
type Trpc = TRPCClient<AppRouter>

// Procedure input/output types inferred from the typed client — no `@naru/core`
// import needed (these are erased at build). `Parameters`/`ReturnType` read the
// shapes straight off the end-to-end-typed `AppRouter` client methods.
type QueryInput<F> = F extends (input: infer I, ...rest: never[]) => unknown ? I : never
type Awaited2<T> = T extends Promise<infer U> ? U : T
type ResultOf<F> = F extends (...args: never[]) => infer R ? Awaited2<R> : never

export type MemorySearchInput = QueryInput<Trpc['memory']['search']['query']>
export type MemorySearchOutput = ResultOf<Trpc['memory']['search']['query']>
export type MemoryAddInput = QueryInput<Trpc['memory']['add']['mutate']>
export type MemoryAddOutput = ResultOf<Trpc['memory']['add']['mutate']>
export type MemoryListInput = QueryInput<Trpc['memory']['list']['query']>
export type MemoryListOutput = ResultOf<Trpc['memory']['list']['query']>
export type MemoryForgetInput = QueryInput<Trpc['memory']['forget']['mutate']>
export type MemoryForgetOutput = ResultOf<Trpc['memory']['forget']['mutate']>
export type MemoryCaptureInput = QueryInput<Trpc['memory']['capture']['mutate']>
export type MemoryCaptureOutput = ResultOf<Trpc['memory']['capture']['mutate']>
export type ContextBuildInput = QueryInput<Trpc['context']['build']['query']>
export type ContextBuildOutput = ResultOf<Trpc['context']['build']['query']>
export type EntityListInput = QueryInput<Trpc['entity']['list']['query']>
export type EntityListOutput = ResultOf<Trpc['entity']['list']['query']>
export type FactGetOutput = ResultOf<Trpc['fact']['get']['query']>
export type SystemStatusOutput = ResultOf<Trpc['system']['status']['query']>
export type ScopeResolveInput = QueryInput<Trpc['scope']['resolve']['mutate']>
export type ScopeResolveOutput = ResultOf<Trpc['scope']['resolve']['mutate']>

/**
 * Default discovery-file reader: read + parse `<dbPath>.naru-server.json` with
 * `node:fs` and validate the four fields we depend on. Returns `null` when the
 * file is absent, unparseable, or structurally invalid — treated as no-server.
 * Mirrors the server's `parseServerFileAt` validation WITHOUT a liveness check
 * (an unreachable but recorded server surfaces as a request-time error so we do
 * not duplicate the `kill(pid, 0)` probe in the bundle).
 */
function defaultReadDiscoveryFile(dbPath: string): DiscoveryFile | null {
  const path = discoveryFilePath(dbPath)
  if (!existsSync(path)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { host, port, token, pid } = parsed as Record<string, unknown>
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof token !== 'string' ||
    typeof pid !== 'number'
  ) {
    return null
  }
  return { host, port, token, pid }
}

/** Strip a single trailing slash so tRPC appends procedure paths cleanly. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Default tRPC client factory: a vanilla typed client with the bearer token
 * attached on every request via a `headers` FUNCTION (re-read per batch so a
 * rotated token would be picked up). Node 24 / Bun supply a global `fetch`, so
 * no polyfill is needed.
 */
function defaultCreateClient(resolved: ResolvedServer): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: resolved.baseUrl,
        headers: () => ({ authorization: `Bearer ${resolved.token}` }),
      }),
    ],
  })
}

/**
 * Resolve the server coordinates in priority order (per task brief):
 *   1. explicit `{ url, token }` passed in,
 *   2. env `NARU_SERVER_URL` + `NARU_SERVER_TOKEN`,
 *   3. the discovery file next to the DB.
 * Returns `null` when nothing resolves (caller raises {@link NoServerError}).
 */
function resolveServerTarget(
  opts: Required<Pick<RemoteClientOptions, 'dbPath' | 'env' | 'readDiscoveryFile'>> & {
    server?: RemoteServerTarget
  },
): ResolvedServer | null {
  // 1) Explicit coordinates win.
  if (opts.server) {
    const url = opts.server.url.trim()
    const token = opts.server.token
    if (url.length > 0 && token.length > 0) {
      return { baseUrl: normalizeBaseUrl(url), token, source: 'explicit' }
    }
  }

  // 2) Environment variables.
  const envUrl = opts.env.NARU_SERVER_URL?.trim()
  const envToken = opts.env.NARU_SERVER_TOKEN
  if (envUrl !== undefined && envUrl.length > 0 && envToken !== undefined && envToken.length > 0) {
    return { baseUrl: normalizeBaseUrl(envUrl), token: envToken, source: 'env' }
  }

  // 3) Discovery file next to the DB.
  const file = opts.readDiscoveryFile(opts.dbPath)
  if (file) {
    return {
      baseUrl: `http://${file.host}:${file.port}`,
      token: file.token,
      source: 'discovery',
    }
  }

  return null
}

/**
 * Create the lazy, graceful remote memory client (plan §17, Bun-safe).
 *
 * Nothing connects at construction. On the first method call the server is
 * resolved (explicit -> env -> discovery file) and the tRPC client is built and
 * memoized. If no server resolves, every call rejects with a {@link NoServerError}
 * carrying the friendly start-the-server message — the plugin is never crashed.
 */
export function createRemoteClient(options: RemoteClientOptions = {}): RemoteClient {
  const resolveOpts = {
    dbPath: options.dbPath ?? defaultDbPath(),
    env: options.env ?? process.env,
    readDiscoveryFile: options.readDiscoveryFile ?? defaultReadDiscoveryFile,
    ...(options.server !== undefined ? { server: options.server } : {}),
  }
  const createClient = options.createClient ?? defaultCreateClient

  let trpc: Trpc | null = null
  let resolved: ResolvedServer | null = null

  /** Resolve + memoize the server; throw {@link NoServerError} if none found. */
  function resolveServer(): ResolvedServer {
    if (resolved !== null) {
      return resolved
    }
    const target = resolveServerTarget(resolveOpts)
    if (target === null) {
      throw new NoServerError()
    }
    resolved = target
    return resolved
  }

  /** Build + memoize the typed tRPC client over the resolved server. */
  function client(): Trpc {
    if (trpc !== null) {
      return trpc
    }
    trpc = createClient(resolveServer())
    return trpc
  }

  // Every data method is `async` so a synchronous {@link NoServerError} from
  // `client()`/`resolveServer()` (no server resolvable) becomes a REJECTED
  // promise rather than a synchronous throw — the tools/hooks can uniformly
  // `await ... .catch()` and the plugin is never crashed. `resolveServer()`
  // itself stays synchronous for the diagnostics use case.
  return {
    resolveServer,

    async search(input) {
      return client().memory.search.query(input)
    },

    async addMemory(input) {
      return client().memory.add.mutate(input)
    },

    async get(id) {
      try {
        return await client().fact.get.query({ id })
      } catch (err) {
        if (isNotFound(err)) {
          return undefined
        }
        throw err
      }
    },

    async list(input) {
      return client().memory.list.query(input)
    },

    async forget(selector) {
      return client().memory.forget.mutate(selector)
    },

    async buildContext(input) {
      return client().context.build.query(input)
    },

    async listEntities(input) {
      return client().entity.list.query(input)
    },

    async status() {
      return client().system.status.query()
    },

    async capture(input) {
      return client().memory.capture.mutate(input)
    },

    async ensureScope(input) {
      return client().scope.resolve.mutate(input)
    },
  }
}

/** Whether a thrown tRPC client error carries a NOT_FOUND code. */
function isNotFound(err: unknown): boolean {
  const data = (err as { data?: { code?: string } }).data
  return data?.code === 'NOT_FOUND'
}
