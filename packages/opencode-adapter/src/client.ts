/**
 * Adapter memory client (plan §17.1/§17.2, §12.3).
 *
 * The OpenCode adapter is an INTEGRATION layer, not the memory system: it calls
 * Naru core APIs (embedded) or a running local server, and owns NO memory
 * logic, NO duplicate extraction, NO direct DB writes, NO schema. This module
 * mirrors the CLI's transport resolution (`apps/cli/src/resolve.ts`): resolve
 * the canonical DB path, look for a LIVE server owning it via the discovery
 * file, and either proxy to it (the single logical writer, §12.3) or operate
 * the DB embedded.
 *
 * It exposes only the SUBSET the tools/hooks need — `addMemory`, `search`,
 * `get`, `list`, `forget`, `buildContext`, `listEntities`, `status`, and
 * `captureExtract` (the §13 capture/extract pipeline). Redaction is owned by
 * core: write paths (`addMemory`, `captureExtract`) redact before persistence
 * (§18.1) and reads return already-redacted facts — the adapter never bypasses
 * this.
 *
 * DI for tests: the DB path / open options are injected, so tests resolve an
 * embedded `:memory:` (or temp) Naru with no network and no real config dir.
 */

import type { AppRouter } from '@naru/api'
import {
  type AddManualInput,
  type BuildContextInput,
  type BuildContextResult,
  type CaptureAndExtractInput,
  type CaptureResult,
  type EntityWithFacts,
  type FactWithEvidence,
  type ForgetSelector,
  type ListInput,
  Naru,
  type NaruOpenOptions,
  type NaruStatus,
  type ScopeSelector,
  type SearchInput,
  type WritableScopeSelector,
  resolveConfig,
} from '@naru/core'
import type { Entity, Fact, Scope, SearchResultItem } from '@naru/schema'
import { type ServerFile, readServerFile } from '@naru/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

/**
 * How the adapter is talking to the store, surfaced by `status` (plan §16/§17):
 * `remote` when proxying to a live local server (§12.3), `embedded` otherwise.
 */
export interface AdapterClientMode {
  mode: 'remote' | 'embedded'
  /** Bound server URL when `mode === 'remote'`. */
  url?: string
}

/** Naru status augmented with how the adapter reached the store (plan §17). */
export interface AdapterStatus extends NaruStatus {
  server: AdapterClientMode
}

/**
 * Transport-agnostic memory client for the adapter's tools/hooks (plan §17.2).
 *
 * Deliberately narrower than the CLI's `MemoryClient`: only the operations the
 * eight native tools (§17.3) and the hooks (§17.4) need. Every method is async
 * so callers `await` uniformly across the embedded (sync core wrapped in a
 * promise) and remote (genuinely async) transports.
 */
export interface AdapterClient {
  /** Get-or-create a scope row so writes/reads resolve it (plan §11.2). */
  ensureScope(type: WritableScopeSelector['type'], key: string, name?: string): Promise<Scope>
  /** Add a manual memory (`infer=false`); core redacts before persistence (§18.1). */
  addMemory(input: AddManualInput): Promise<Fact>
  /**
   * Capture an episode + run extraction-driven ingestion (`infer=true`, §13).
   * Core redacts the episode first (§18.1); the adapter never pre-extracts.
   */
  captureExtract(input: CaptureAndExtractInput): Promise<CaptureResult>
  /** Scoped hybrid search; reads return already-redacted facts (§9.4, §18.1). */
  search(input: SearchInput): Promise<SearchResultItem[]>
  /** Token-bounded prompt context for injection hooks (§14.4). */
  buildContext(input: BuildContextInput): Promise<BuildContextResult>
  /** List facts by scope/status (§15.2). */
  list(input?: ListInput): Promise<Fact[]>
  /** Get one fact with its evidence (§15.2). */
  get(id: string): Promise<FactWithEvidence | undefined>
  /** List entities, optionally scoped (§15.2 `entity.list`). */
  listEntities(scope?: ScopeSelector): Promise<Entity[]>
  /** Destructive privacy purge by selector (§18.2). */
  forget(selector: ForgetSelector): Promise<{ deleted: number }>
  /** Status snapshot incl. transport mode (§15.2, §17). */
  status(): Promise<AdapterStatus>
  /** Release transport resources (closes the embedded DB; no-op remote). */
  close(): Promise<void>
}

/**
 * Embedded adapter client: drives a local {@link Naru} in-process (plan §12.3
 * embedded fallback). Reads call straight through; the adapter does no write
 * locking of its own — when a live server is present the resolver hands back a
 * {@link RemoteAdapterClient} instead, so the server stays the single logical
 * writer. (The adapter is not a long-lived multi-writer like the CLI process
 * pool; per-call resolution against the discovery file is the coordination
 * point.)
 */
export class EmbeddedAdapterClient implements AdapterClient {
  constructor(private readonly naru: Naru) {}

  ensureScope(type: WritableScopeSelector['type'], key: string, name?: string): Promise<Scope> {
    return Promise.resolve(this.naru.ensureScope(type, key, name))
  }

  addMemory(input: AddManualInput): Promise<Fact> {
    return Promise.resolve(this.naru.addMemory(input))
  }

  captureExtract(input: CaptureAndExtractInput): Promise<CaptureResult> {
    return this.naru.capture(input)
  }

  search(input: SearchInput): Promise<SearchResultItem[]> {
    // Async hybrid path so the vector signal participates when an embedder is
    // configured; degrades to lexical/entity otherwise (plan §14, §17.4).
    return this.naru.searchHybrid(input)
  }

  buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    return this.naru.buildContext(input)
  }

  list(input?: ListInput): Promise<Fact[]> {
    return Promise.resolve(this.naru.list(input))
  }

  get(id: string): Promise<FactWithEvidence | undefined> {
    return Promise.resolve(this.naru.get(id))
  }

  listEntities(scope?: ScopeSelector): Promise<Entity[]> {
    return Promise.resolve(this.naru.listEntities(scope))
  }

  forget(selector: ForgetSelector): Promise<{ deleted: number }> {
    return Promise.resolve(this.naru.forget(selector))
  }

  status(): Promise<AdapterStatus> {
    return Promise.resolve({ ...this.naru.status(), server: { mode: 'embedded' } })
  }

  close(): Promise<void> {
    this.naru.close()
    return Promise.resolve()
  }
}

/** Typed vanilla tRPC client bound to the discovered server (plan §15). */
type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>

/**
 * Build a typed tRPC client for the discovered local server, attaching the
 * bearer token from its discovery file on every request (plan §15.3). Node 24
 * supplies a global `fetch`, so no polyfill is needed.
 */
function buildTrpcClient(server: ServerFile): TrpcClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://${server.host}:${server.port}`,
        headers: { authorization: `Bearer ${server.token}` },
      }),
    ],
  })
}

/**
 * Remote adapter client: proxies every operation to the running local server
 * over the typed tRPC transport (plan §12.3 single logical writer, §15). Writes
 * land in the server's serialized ingestion queue, so §9 scope-safety and §18
 * redaction/forget stay enforced on the core/server side — never re-implemented
 * here. NOT_FOUND from `fact.get` is mapped back to `undefined`.
 */
export class RemoteAdapterClient implements AdapterClient {
  private readonly trpc: TrpcClient

  constructor(private readonly server: ServerFile) {
    this.trpc = buildTrpcClient(server)
  }

  ensureScope(type: WritableScopeSelector['type'], key: string, name?: string): Promise<Scope> {
    return this.trpc.scope.resolve.mutate({ type, key, ...(name !== undefined ? { name } : {}) })
  }

  addMemory(input: AddManualInput): Promise<Fact> {
    return this.trpc.memory.add.mutate(input)
  }

  captureExtract(input: CaptureAndExtractInput): Promise<CaptureResult> {
    return this.trpc.memory.capture.mutate(input)
  }

  search(input: SearchInput): Promise<SearchResultItem[]> {
    return this.trpc.memory.search.query(input)
  }

  buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    return this.trpc.context.build.query(input)
  }

  list(input?: ListInput): Promise<Fact[]> {
    return this.trpc.memory.list.query(input)
  }

  async get(id: string): Promise<FactWithEvidence | undefined> {
    try {
      return await this.trpc.fact.get.query({ id })
    } catch (err) {
      if (isNotFound(err)) {
        return undefined
      }
      throw err
    }
  }

  listEntities(scope?: ScopeSelector): Promise<Entity[]> {
    return this.trpc.entity.list.query(scope !== undefined ? { scope } : undefined)
  }

  forget(selector: ForgetSelector): Promise<{ deleted: number }> {
    return this.trpc.memory.forget.mutate(selector)
  }

  async status(): Promise<AdapterStatus> {
    const status = await this.trpc.system.status.query()
    return {
      ...status,
      server: { mode: 'remote', url: `http://${this.server.host}:${this.server.port}` },
    }
  }

  close(): Promise<void> {
    // The HTTP transport is stateless (no kept-open connection to release).
    return Promise.resolve()
  }
}

/** Whether a thrown tRPC client error carries a NOT_FOUND code. */
function isNotFound(err: unknown): boolean {
  const data = (err as { data?: { code?: string } }).data
  return data?.code === 'NOT_FOUND'
}

/**
 * Resolve the adapter's {@link AdapterClient} for the given open options
 * (plan §12.3, mirrors `apps/cli/src/resolve.ts`).
 *
 * Resolves the canonical DB path the same way the embedded store would (core's
 * {@link resolveConfig}, honoring an injected `db`/default), then looks for a
 * LIVE server owning that DB via its discovery file. A live server is the
 * single logical writer, so the adapter proxies to it; a stale/absent file
 * means no owner, so it operates the DB embedded.
 *
 * Inject `options.db` (`:memory:` or a temp path) in tests to get a fully
 * offline embedded client with no real config dir / network.
 */
export function resolveAdapterClient(options: NaruOpenOptions = {}): AdapterClient {
  const { dbPath } = resolveConfig({
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.retentionMode !== undefined ? { retentionMode: options.retentionMode } : {}),
  })

  const server = readServerFile(dbPath)
  if (server) {
    return new RemoteAdapterClient(server)
  }

  const naru = Naru.open(options)
  return new EmbeddedAdapterClient(naru)
}
