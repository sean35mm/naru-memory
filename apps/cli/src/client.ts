import type {
  AddManualInput,
  BuildContextInput,
  BuildContextResult,
  CaptureAndExtractInput,
  CaptureResult,
  EntityWithFacts,
  FactWithEvidence,
  ForgetSelector,
  HistoryEntry,
  ListInput,
  Naru,
  NaruStatus,
  ScopeSelector,
  SearchInput,
  WritableScopeSelector,
} from '@naru/core'
import type { Entity, Episode, Fact, Scope, SearchResultItem, Supersession } from '@naru/schema'
import { readServerFile } from '@naru/server'
import { acquireLock } from './lock'
import { RemoteClient } from './remote-client'

/**
 * How a {@link MemoryClient} is talking to the store, surfaced by `status`
 * (plan §16): `remote` when proxying to a live local server (the single-writer
 * rule, §12.3), `embedded` when operating the local DB directly.
 */
export interface ClientMode {
  mode: 'remote' | 'embedded'
  /** Bound server URL when `mode === 'remote'`. */
  url?: string
}

/** Status augmented with how the client reached the store (plan §16). */
export interface ClientStatus extends NaruStatus {
  server: ClientMode
}

/**
 * Transport-agnostic memory client used by every CLI command (plan §12.3).
 *
 * The command handlers depend ONLY on this interface so they behave identically
 * whether the store is reached in-process ({@link EmbeddedClient}) or proxied to
 * a running local server ({@link RemoteClient}). All methods are async: the
 * embedded store is synchronous and simply wraps its result in a promise, while
 * the remote transport is genuinely async. Keeping one async shape lets the
 * commands `await` uniformly and keeps the §9/§18 invariants on the core/server
 * side — never re-implemented per transport.
 */
export interface MemoryClient {
  ensureScope(type: ScopeSelector['type'], key: string, name?: string): Promise<Scope>
  addMemory(input: AddManualInput): Promise<Fact>
  /**
   * Capture an episode and run extraction-driven ingestion (`infer=true`, plan
   * §13). Always async: the embedded store runs it in-process (under the write
   * lock); the remote transport proxies to the server's `memory.capture`, which
   * runs it inside the single-writer queue.
   */
  capture(input: CaptureAndExtractInput): Promise<CaptureResult>
  search(input: SearchInput): Promise<SearchResultItem[]>
  /**
   * Build a token-bounded prompt context (plan §14.4 `context.build`): runs the
   * hybrid scope-safe search, then packs top-ranked items into a `promptBlock`
   * within the token budget. A read — the embedded store runs it in-process (no
   * write lock); the remote transport proxies to `context.build`.
   */
  buildContext(input: BuildContextInput): Promise<BuildContextResult>
  list(input?: ListInput): Promise<Fact[]>
  get(id: string): Promise<FactWithEvidence | undefined>
  listEntities(scope?: ScopeSelector): Promise<Entity[]>
  getEntity(id: string): Promise<EntityWithFacts | undefined>
  forget(selector: ForgetSelector): Promise<{ deleted: number }>
  supersede(oldId: string, newId: string, reason?: string): Promise<Supersession>
  history(factId: string): Promise<HistoryEntry[]>
  captureEpisode(input: {
    text: string
    scope: WritableScopeSelector
    sourceType: Episode['sourceType']
    sourceRef?: string | null
    observedAt?: string
  }): Promise<Episode>
  reindex(): Promise<void>
  status(): Promise<ClientStatus>
  /** Release any transport resources (closes the embedded DB; no-op remote). */
  close(): Promise<void>
}

/**
 * Embedded client: drives a local {@link Naru} directly (plan §12.3 embedded
 * fallback). Reads call straight through; WRITES first take the per-DB lock
 * next to the DB so two embedded writers cannot run concurrently, and always
 * release it in `finally`. Reads take no lock — WAL allows concurrent readers
 * (plan §12.3).
 *
 * To preserve the single-logical-writer invariant across the embedded/server
 * boundary, a write re-checks the discovery file UNDER THE LOCK: if a live
 * server has appeared since this client was resolved (a startup race where no
 * server.json existed at resolve time but one was published before the write
 * ran), the write is redirected to that server instead of executing a second
 * concurrent writer against the same file.
 */
export class EmbeddedClient implements MemoryClient {
  constructor(
    private readonly naru: Naru,
    private readonly dbPath: string,
  ) {}

  /**
   * Run a write under the exclusive embedded lock, releasing it afterwards.
   *
   * Under the lock it re-resolves the discovery file. If a live server now owns
   * the DB, it redirects `remote` through a transient {@link RemoteClient} (and
   * does NOT touch the local store), so the server stays the single logical
   * writer. Otherwise it runs `body` against the local store as before.
   */
  private async write<T>(
    body: () => T | Promise<T>,
    remote: (client: MemoryClient) => Promise<T>,
  ): Promise<T> {
    const lock = acquireLock(this.dbPath)
    try {
      const server = readServerFile(this.dbPath)
      if (server) {
        return await remote(new RemoteClient(server))
      }
      // Await so an async body (e.g. extraction-driven `capture`) completes
      // while the embedded lock is still held; a sync body is unaffected.
      return await body()
    } finally {
      lock.release()
    }
  }

  ensureScope(type: ScopeSelector['type'], key: string, name?: string): Promise<Scope> {
    return this.write(
      () => this.naru.ensureScope(type, key, name),
      (client) => client.ensureScope(type, key, name),
    )
  }

  addMemory(input: AddManualInput): Promise<Fact> {
    return this.write(
      () => this.naru.addMemory(input),
      (client) => client.addMemory(input),
    )
  }

  capture(input: CaptureAndExtractInput): Promise<CaptureResult> {
    return this.write(
      () => this.naru.capture(input),
      (client) => client.capture(input),
    )
  }

  search(input: SearchInput): Promise<SearchResultItem[]> {
    return Promise.resolve(this.naru.search(input))
  }

  buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    // A read (no write lock): the underlying hybrid search enforces §9.4 scope
    // safety; `buildContext` is already async (it embeds the query).
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

  getEntity(id: string): Promise<EntityWithFacts | undefined> {
    return Promise.resolve(this.naru.getEntity(id))
  }

  forget(selector: ForgetSelector): Promise<{ deleted: number }> {
    return this.write(
      () => this.naru.forget(selector),
      (client) => client.forget(selector),
    )
  }

  supersede(oldId: string, newId: string, reason?: string): Promise<Supersession> {
    return this.write(
      () => this.naru.supersede(oldId, newId, reason),
      (client) => client.supersede(oldId, newId, reason),
    )
  }

  history(factId: string): Promise<HistoryEntry[]> {
    return Promise.resolve(this.naru.history(factId))
  }

  captureEpisode(input: {
    text: string
    scope: WritableScopeSelector
    sourceType: Episode['sourceType']
    sourceRef?: string | null
    observedAt?: string
  }): Promise<Episode> {
    return this.write(
      () => this.naru.captureEpisode(input),
      (client) => client.captureEpisode(input),
    )
  }

  reindex(): Promise<void> {
    return this.write(
      () => this.naru.reindex(),
      (client) => client.reindex(),
    )
  }

  status(): Promise<ClientStatus> {
    return Promise.resolve({ ...this.naru.status(), server: { mode: 'embedded' } })
  }

  close(): Promise<void> {
    this.naru.close()
    return Promise.resolve()
  }
}
