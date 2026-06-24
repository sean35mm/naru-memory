import type {
  Entity,
  Episode,
  Fact,
  IndexState,
  RetentionMode,
  Scope,
  ScopeType,
  SearchResultItem,
  SourceType,
  Supersession,
} from '@naru/schema'
import { Store } from '@naru/store-sqlite'
import type { BackupResult } from '@naru/store-sqlite'
import {
  type BundleEmbedding,
  type ExportBundleOptions,
  type ImportResult,
  type MemoryBundle,
  exportBundle,
  importBundle,
  readBundleFile,
  writeBundle,
} from './bundle'
import { type EmbeddingsConfig, type LlmConfig, type NaruConfig, resolveConfig } from './config'
import { type VectorCapability, createEmbedder, detectVectorCapability } from './embedding'
import { createExtractor } from './extraction'
import {
  type IntegrityReport,
  type RepairResult,
  checkIntegrity,
  repair as runRepair,
} from './integrity'
import {
  type EventSink,
  type ForgetEvent,
  type Logger,
  type ObservabilityConfig,
  type SearchEvent,
  createLogger,
  resolveObservability,
  stderrJsonSink,
} from './logger'
import {
  type AddManualInput,
  type BuildContextInput,
  type BuildContextResult,
  type CaptureAndExtractInput,
  type CaptureResult,
  type EntityWithFacts,
  type FactWithEvidence,
  type ForgetSelector,
  type HistoryEntry,
  type ListInput,
  MemoryService,
  type SearchInput,
} from './memory-service'
import type { ScopeSelector, WritableScopeSelector } from './scope-service'
import { ScopeService } from './scope-service'

/** Options for {@link Naru.open}. */
export interface NaruOpenOptions {
  /** DB path override; ':memory:' for tests. Defaults to plan §23 location. */
  db?: string
  /** Retention mode override; defaults to `redacted` (plan §10.2). */
  retentionMode?: RetentionMode
  /**
   * Optional LLM extractor configuration (plan §6.2, §13.2). When unset (or
   * `provider: 'none'`) extraction stays unavailable. Use `provider: 'mock'`
   * for the deterministic offline/test backend.
   */
  llm?: LlmConfig
  /**
   * Optional embeddings configuration (plan §6.2, §11.9, M3). When unset (or
   * `provider: 'none'`) vector retrieval is OFF and search degrades gracefully
   * to BM25/entity/recency. Use `provider: 'mock'` for the deterministic
   * offline/test backend.
   */
  embeddings?: EmbeddingsConfig
  /**
   * Observability verbosity (plan §18 logs / §20 M5). Defaults to OFF; falls
   * back to the `NARU_LOG` env var when unset. Emits ONLY non-sensitive events
   * (counts/ids/hashes/timings/scope keys) — never memory text or secrets.
   */
  observability?: ObservabilityConfig
  /**
   * Sink for emitted observability events (plan §20 M5). Defaults to a compact
   * JSON-line-per-event stderr writer; tests inject an in-memory collector.
   * Only consulted when observability is enabled.
   */
  eventSink?: EventSink
  /**
   * Write-coordination guard for admin writes (import/repair) (plan §12.3).
   *
   * Import is a WRITE, so the single-logical-writer rule applies. When a live
   * local server owns this DB, an embedded process must NOT open a second writer
   * — it should proxy to the server or refuse. The {@link Naru} facade does not
   * know about the server discovery file (that lives in the CLI/server layer),
   * so the caller injects this guard: it is invoked at the start of an admin
   * write and SHOULD throw with operator guidance when a live server owns the DB.
   * Defaults to a no-op (embedded-only usage / tests).
   */
  adminWriteGuard?: () => void
  /**
   * Open the underlying store READ-ONLY (plan §12.3 read-only admin ops). When
   * true the SQLite connection is opened read-only and NO migrations run — the
   * schema is validated instead (a missing/behind-schema DB fails fast). This is
   * how genuinely read-only operations (export/backup/check) avoid opening a
   * second writer-capable connection or running migration writes behind a live
   * server. Defaults to false. WRITE operations (import/repair) must NOT set it.
   */
  readonly?: boolean
}

/** Status snapshot (plan §15.2 `system.status`, §10.1 rebuildability surfacing). */
export interface NaruStatus {
  dbPath: string
  /** On-disk config schema version this config was migrated to (plan §23). */
  configVersion: number
  counts: {
    facts: number
    entities: number
    episodes: number
    scopes: number
  }
  retentionMode: RetentionMode
  /** Observability verbosity in effect (plan §18 / §20 M5). */
  observability: ObservabilityConfig
  /** Capability seams for later milestones (plan §13.3, §6.2, §15). */
  features: {
    /**
     * Extractor capability (plan §13.3): `available` with provider/model once an
     * LLM/mock extractor is configured, else `unavailable`.
     */
    extractor: NaruExtractorStatus
    /**
     * Vector subsystem capability (plan §12.2, §15.2): the active KNN backend
     * (`bruteforce`) and embedder availability. `embedder.available` is false
     * when no embedder is configured (vector retrieval OFF).
     */
    vector: VectorCapability
    server: 'embedded'
  }
}

/** Extractor capability surface for `status()` (plan §13.3, §6.2). */
export type NaruExtractorStatus =
  | { available: false }
  | { available: true; provider: string; model?: string }

/**
 * Embedded Naru Memory facade (plan §12.3 embedded mode).
 *
 * Wires the canonical store + scope/memory services and exposes the
 * Milestone-1 product surface. Construct via {@link Naru.open}; the underlying
 * `better-sqlite3` connection is synchronous, so all methods are synchronous.
 */
export class Naru {
  private constructor(
    private readonly store: Store,
    private readonly scopeService: ScopeService,
    private readonly memory: MemoryService,
    private readonly config: NaruConfig,
    /** Structured observability seam (plan §18 / §20 M5); OFF by default. */
    private readonly logger: Logger,
    /** §12.3 admin-write guard (defaults to a no-op); see {@link NaruOpenOptions}. */
    private readonly adminWriteGuard: () => void = () => {},
  ) {}

  /** Open the store and build services from resolved config (plan §23). */
  static open(options: NaruOpenOptions = {}): Naru {
    // Observability is opt-in (plan §18 logs caveat): explicit option, else env.
    const observability = resolveObservability(options.observability)
    const config = resolveConfig({
      db: options.db,
      retentionMode: options.retentionMode,
      observability,
      llm: options.llm,
      embeddings: options.embeddings,
    })
    const store = Store.open({ path: config.dbPath, readonly: options.readonly ?? false })
    const scopeService = new ScopeService(store)
    // Provider-agnostic: `null` when no/`none` provider is configured, which
    // keeps extraction UNAVAILABLE and the manual path the only ingestion route
    // (plan §6.2, §13.3). `mock` is the deterministic offline/test backend.
    const extractor = createExtractor(config.llm)
    // Likewise `null` when no/`none` embedder is configured -> vector retrieval
    // is OFF and search degrades to BM25/entity/recency (plan §6.2, M3).
    const embedder = createEmbedder(config.embeddings)
    const memory = new MemoryService(store, scopeService, config.retentionMode, extractor, embedder)
    const logger = createLogger(config.observability, options.eventSink ?? stderrJsonSink)
    return new Naru(
      store,
      scopeService,
      memory,
      config,
      logger,
      options.adminWriteGuard ?? (() => {}),
    )
  }

  /** Get-or-create a scope by `(type, key)` (plan §11.2). */
  ensureScope(type: ScopeType, key: string, name?: string): Scope {
    return this.scopeService.ensureScope(type, key, name)
  }

  /** List all known scopes (plan §15.2 `scope.list`). */
  listScopes(): Scope[] {
    return this.scopeService.list()
  }

  /** Add a manual memory with `infer=false` (plan §13.3). */
  addMemory(input: AddManualInput): Fact {
    const start = this.startTimer()
    const before = this.factCount()
    const fact = this.memory.addManual(input)
    // A dedupe hit returns an existing fact without growing the table; an insert
    // grows it. Inferring from the count avoids reading any fact TEXT.
    const deduped = this.factCount() === before
    this.logger.emit({
      operation: 'add',
      level: 'info',
      factId: fact.id,
      statementHash: fact.statementHash,
      deduped,
      scope: { type: input.scope.type, key: input.scope.key },
      durationMs: this.elapsed(start),
    })
    return fact
  }

  /**
   * Capture an episode and run extraction-driven ingestion (`infer=true`, plan
   * §13). Redacts first, stores the redacted episode, then extracts/dedupes/
   * supersedes via the configured provider. With no provider (or on provider
   * error) it never fails — it stores the redacted episode and falls back to a
   * single manual fact (plan §13.3). Async because extraction may be an LLM call.
   */
  async capture(input: CaptureAndExtractInput): Promise<CaptureResult> {
    const start = this.startTimer()
    const result = await this.memory.captureAndExtract(input)
    this.logger.emit({
      operation: 'capture',
      level: 'info',
      episodeId: result.episode.id,
      factCount: result.facts.length,
      extracted: this.memory.hasExtractor(),
      scope: { type: input.scope.type, key: input.scope.key },
      durationMs: this.elapsed(start),
    })
    return result
  }

  /**
   * Synchronous scoped search (plan §14, §9.4). Lexical/entity ranking only; the
   * semantic vector signal requires the async {@link searchHybrid} (the embedder
   * is async). With no embedder configured this is the full hybrid behavior.
   */
  search(input: SearchInput): SearchResultItem[] {
    const start = this.startTimer()
    const results = this.memory.search(input)
    this.emitSearch(input, results.length, false, start)
    return results
  }

  /**
   * Async hybrid scoped search (plan §14, §9.4): embeds the query and includes
   * the vector signal when an embedder is configured; degrades to lexical/entity
   * ranking otherwise (or on embed failure).
   */
  async searchHybrid(input: SearchInput): Promise<SearchResultItem[]> {
    const start = this.startTimer()
    const results = await this.memory.searchHybrid(input)
    this.emitSearch(input, results.length, this.memory.hasEmbedder(), start)
    return results
  }

  /**
   * Build token-bounded structured context (plan §14.4 `context.build`): runs the
   * hybrid search then packs the top-ranked items into a prompt block within the
   * token budget (default 1024). Scope-safe via the underlying search.
   */
  buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    return this.memory.buildContext(input)
  }

  /**
   * Deliberately (re)embed all active facts and refresh the vector index (plan
   * §12.2). No-op when no embedder is configured. Use after synchronous
   * {@link addMemory} writes to populate vectors for semantic retrieval.
   */
  reindexVectors(): Promise<{ embedded: number }> {
    return this.memory.reindexVectors()
  }

  /** List facts by scope/status (plan §15.2). */
  list(input?: ListInput): Fact[] {
    return this.memory.list(input)
  }

  /** Get one fact with its evidence (plan §15.2). */
  get(id: string): FactWithEvidence | undefined {
    return this.memory.get(id)
  }

  /** List entities, optionally scoped (plan §15.2 `entity.list`). */
  listEntities(scope?: ScopeSelector): Entity[] {
    return this.memory.listEntities(scope)
  }

  /** Get one entity with its linked active facts (plan §15.2 `entity.get`). */
  getEntity(id: string): EntityWithFacts | undefined {
    return this.memory.getEntity(id)
  }

  /** Destructive privacy purge by selector (plan §18.2). */
  forget(selector: ForgetSelector): { deleted: number } {
    const start = this.startTimer()
    const result = this.memory.forget(selector)
    // Emit which selector FIELDS were used (e.g. ['scope','before']) — never
    // their values (a `factId`/`text` value could be sensitive).
    const selectorKinds = Object.keys(selector).filter(
      (k) => selector[k as keyof ForgetSelector] !== undefined,
    )
    const event: ForgetEvent = {
      operation: 'forget',
      level: 'info',
      deleted: result.deleted,
      selectorKinds,
      durationMs: this.elapsed(start),
    }
    if (selector.scope) {
      event.scope = { type: selector.scope.type, key: selector.scope.key }
    }
    this.logger.emit(event)
    return result
  }

  /** Manually supersede one fact with another (plan §13.6). */
  supersede(oldId: string, newId: string, reason?: string): Supersession {
    return this.memory.supersede(oldId, newId, reason)
  }

  /** Supersession chain for a fact (plan §14.3). */
  history(factId: string): HistoryEntry[] {
    return this.memory.history(factId)
  }

  /** Capture a raw episode with redaction (plan §13.1). */
  captureEpisode(input: {
    text: string
    scope: WritableScopeSelector
    sourceType: SourceType
    sourceRef?: string | null
    observedAt?: string
  }): Episode {
    return this.memory.captureEpisode(input)
  }

  /**
   * Rebuild derived indexes from canonical rows (plan §12.2): always the FTS
   * tables, and — when an embedder is configured — the vector index too (drop +
   * re-embed every active fact). Async because re-embedding may be a remote call.
   */
  reindex(): Promise<void> {
    return this.memory.reindex()
  }

  /**
   * Snapshot of derived-index freshness (plan §11.10, §15.2 `index.status`).
   *
   * Returns the tracked `index_state` rows for the known derived indexes
   * (`facts_fts`, `entities_fts`). M1 rebuilds the FTS tables directly without
   * writing `index_state` rows, so an untracked index is reported as `stale`
   * (rebuildable, freshness not yet tracked) rather than omitted. Per-source
   * watermark tracking is a later-milestone concern (plan §12.2).
   */
  indexStatus(): IndexState[] {
    const known = ['facts_fts', 'entities_fts']
    const tracked = new Map(this.store.indexState.list().map((s) => [s.indexName, s]))
    return known.map(
      (name) =>
        tracked.get(name) ?? {
          indexName: name,
          indexVersion: '0',
          sourceWatermark: null,
          sourceHash: null,
          status: 'stale',
          lastRebuiltAt: null,
          error: null,
          metadata: {},
        },
    )
  }

  /** Status snapshot, surfacing retention/rebuildability (plan §10.1, §15.2). */
  status(): NaruStatus {
    const counts = this.count()
    return {
      dbPath: this.config.dbPath,
      configVersion: this.config.configVersion,
      counts,
      retentionMode: this.config.retentionMode,
      observability: this.config.observability,
      features: {
        extractor: this.extractorStatus(),
        vector: this.vectorStatus(),
        server: 'embedded',
      },
    }
  }

  /**
   * Vector capability (plan §12.2, §15.2): the active KNN backend (`bruteforce`)
   * plus embedder availability/identity. Surfaces the embedder's actual model
   * (the live provider's model, which reflects the factory default when config
   * omits one) so `status` reflects exactly what `Naru.open` wired.
   */
  private vectorStatus(): VectorCapability {
    const embedder =
      this.memory.hasEmbedder() && this.memory.embedderName() && this.memory.embedderDimension()
        ? {
            name: this.memory.embedderName() as string,
            model: this.memory.embedderModel() as string,
            dimension: this.memory.embedderDimension() as number,
          }
        : null
    if (!embedder) {
      return detectVectorCapability(null)
    }
    // Prefer the live embedder's model (covers the factory default when config
    // omits one); fall back to config only if the provider exposes no model.
    const model = embedder.model ?? this.config.embeddings?.model
    const options = model ? { model } : {}
    // detectVectorCapability reads name/dimension off a provider; build a minimal
    // stand-in carrying exactly what status needs (the live provider is private).
    return detectVectorCapability(
      {
        name: embedder.name,
        model: embedder.model,
        dimension: embedder.dimension,
        embed: async () => [],
      },
      options,
    )
  }

  /**
   * Extractor capability (plan §13.3): `available` with provider/model when an
   * extractor is configured, else `unavailable`. Reads provider/model from
   * config so `status` reflects exactly what `Naru.open` wired.
   */
  private extractorStatus(): NaruExtractorStatus {
    if (!this.memory.hasExtractor()) {
      return { available: false }
    }
    const provider = this.memory.extractorName() ?? this.config.llm?.provider ?? 'unknown'
    const status: NaruExtractorStatus = { available: true, provider }
    if (this.config.llm?.model) {
      status.model = this.config.llm.model
    }
    return status
  }

  /**
   * Export a portable memory bundle (plan §19): canonical tables only, honoring
   * retention (under `minimal`/`none` no episode/evidence text is included) and
   * stamping the configured embedding provenance so an importer can warn about
   * re-embedding. Read-only.
   */
  exportBundle(options: ExportBundleOptions = {}): MemoryBundle {
    const start = this.startTimer()
    const embedding = options.embedding ?? this.embeddingProvenance()
    const bundle = exportBundle(
      this.store,
      this.config.retentionMode,
      embedding ? { embedding } : {},
    )
    this.logger.emit({
      operation: 'export',
      level: 'info',
      counts: bundleCounts(bundle),
      durationMs: this.elapsed(start),
    })
    return bundle
  }

  /** Export a bundle and write it to a JSON file (plan §19). Read-only. */
  writeBundle(filePath: string, options: ExportBundleOptions = {}): MemoryBundle {
    const embedding = options.embedding ?? this.embeddingProvenance()
    return writeBundle(
      this.store,
      this.config.retentionMode,
      filePath,
      embedding ? { embedding } : {},
    )
  }

  /**
   * Import a portable memory bundle from a parsed object or a JSON file path
   * (plan §19). A WRITE: first runs the §12.3 admin-write guard (refuses when a
   * live server owns the DB; the embedded transaction is the writer lock here),
   * validates the schema/hash version, inserts canonical rows in one transaction
   * with dedupe + id-remap, then rebuilds derived indexes — FTS always, vectors
   * only when an embedder is configured (else `reembedNeeded` is reported with
   * the bundle's embedding provenance). Async because re-embedding may be remote.
   */
  async importBundle(bundleOrFile: MemoryBundle | string): Promise<ImportResult> {
    // §12.3: an admin write must not open a second writer behind a live server.
    this.adminWriteGuard()
    const start = this.startTimer()
    const bundle = typeof bundleOrFile === 'string' ? readBundleFile(bundleOrFile) : bundleOrFile
    // The live embedder's provenance (when configured) lets the importer warn
    // when it differs from the bundle's recorded embedding (plan §19 mismatch).
    const liveEmbedding = this.embeddingProvenance()
    const result = await importBundle(this.store, bundle, {
      // Rebuild derived indexes (plan §12.2): FTS always; vectors only when an
      // embedder is configured. Returns the embedded count, or null (no embedder)
      // so the importer reports a re-embed-needed warning.
      rebuildVectors: async () => {
        this.store.rebuildFts()
        if (!this.memory.hasEmbedder()) {
          return null
        }
        this.store.vectors.clearVectors()
        return this.memory.reindexVectors()
      },
      ...(liveEmbedding ? { liveEmbedding } : {}),
    })
    this.logger.emit({
      operation: 'import',
      level: result.embeddingMismatch ? 'warn' : 'info',
      counts: { ...result.imported },
      reembedNeeded: result.reembedNeeded !== undefined,
      embeddingMismatch: result.embeddingMismatch !== undefined,
      durationMs: this.elapsed(start),
    })
    return result
  }

  /**
   * Run DB integrity checks (plan §22 index staleness / privacy delete gaps,
   * §12.2 rebuildability): native `PRAGMA integrity_check`/`foreign_key_check`
   * plus logical orphan/drift probes. Returns a privacy-safe report (ids +
   * counts + kinds only, never memory TEXT). Read-only.
   */
  checkIntegrity(): IntegrityReport {
    const start = this.startTimer()
    const report = checkIntegrity(this.store)
    this.logger.emit({
      operation: 'integrity',
      level: report.ok ? 'info' : 'warn',
      ok: report.ok,
      // Problem KINDS + counts only (mirrors the privacy-safe IntegrityReport):
      // no sampleIds emitted, since they are opaque row ids we still keep out of
      // the event stream for a tighter blast radius.
      problems: Object.fromEntries(report.problems.map((p) => [p.kind, p.count])),
      durationMs: this.elapsed(start),
    })
    return report
  }

  /**
   * Repair derived/orphan state from canonical data (plan §22, §12.2). A WRITE:
   * first runs the §12.3 admin-write guard (refuses when a live server owns the
   * DB; the embedded transactions are the writer lock here), then prunes
   * orphaned derived/reference rows, clears dangling entity links, rebuilds the
   * FTS tables (and vectors when an embedder is configured), and recomputes
   * `index_state`. Idempotent; never deletes a canonical fact. Async because
   * re-embedding may be a remote call.
   */
  async repair(): Promise<RepairResult> {
    // §12.3: an admin write must not open a second writer behind a live server.
    this.adminWriteGuard()
    const start = this.startTimer()
    const result = await runRepair(this.store, {
      // Rebuild derived indexes from canonical rows (plan §12.2): FTS always;
      // vectors only when an embedder is configured (else null -> vector index
      // left empty, same contract as bundle import).
      rebuildIndexes: async () => {
        this.store.rebuildFts()
        if (!this.memory.hasEmbedder()) {
          return null
        }
        this.store.vectors.clearVectors()
        return this.memory.reindexVectors()
      },
    })
    const prunedTotal =
      result.pruned.evidence +
      result.pruned.factVectors +
      result.pruned.edges +
      result.pruned.supersessions +
      result.danglingEntityLinksCleared
    this.logger.emit({
      operation: 'repair',
      level: 'info',
      ftsRebuilt: result.ftsRebuilt,
      vectorsEmbedded: result.vectorsRebuilt?.embedded ?? null,
      prunedTotal,
      durationMs: this.elapsed(start),
    })
    return result
  }

  /**
   * Write a safe, consistent backup snapshot of the canonical DB to `destPath`
   * (plan §20 M5 backup, §12.3). Uses SQLite `VACUUM INTO` — a point-in-time
   * read transaction that produces a standalone `.db` (no WAL/SHM sidecars)
   * chmod'd 0600. READ-ONLY w.r.t. the live DB (no rows/schema touched). After
   * writing, the snapshot is opened read-only and its canonical `facts`/`scopes`
   * counts are verified to match the source; a mismatch throws. The destination
   * must not already exist. Returns the path + byte size + verified counts.
   */
  backupTo(destPath: string): BackupOutcome {
    const start = this.startTimer()
    const sourceCounts = this.count()
    const { path, bytes } = this.store.backupTo(destPath)

    // Verify the snapshot opens and carries identical canonical counts. Opened
    // read-only so verification cannot mutate the snapshot; closed immediately.
    const verifyStore = Store.open({ path, readonly: true })
    let verifiedCounts: NaruStatus['counts']
    try {
      verifiedCounts = {
        facts: countTable(verifyStore, 'facts'),
        entities: countTable(verifyStore, 'entities'),
        episodes: countTable(verifyStore, 'episodes'),
        scopes: countTable(verifyStore, 'scopes'),
      }
    } finally {
      verifyStore.close()
    }
    const verified =
      verifiedCounts.facts === sourceCounts.facts && verifiedCounts.scopes === sourceCounts.scopes
    if (!verified) {
      throw new Error(
        `backup verification failed: snapshot counts (facts=${verifiedCounts.facts}, scopes=${verifiedCounts.scopes}) do not match source (facts=${sourceCounts.facts}, scopes=${sourceCounts.scopes})`,
      )
    }

    this.logger.emit({
      operation: 'backup',
      level: 'info',
      bytes,
      verified,
      durationMs: this.elapsed(start),
    })
    return { path, bytes, verified, counts: verifiedCounts }
  }

  /**
   * Embedding provenance for an export (plan §19): the configured embedder's
   * provider/model/dimension, or `undefined` when none is configured.
   */
  private embeddingProvenance(): BundleEmbedding | undefined {
    if (
      !this.memory.hasEmbedder() ||
      !this.memory.embedderName() ||
      !this.memory.embedderModel() ||
      this.memory.embedderDimension() === undefined
    ) {
      return undefined
    }
    return {
      provider: this.memory.embedderName() as string,
      model: this.memory.embedderModel() as string,
      dimension: this.memory.embedderDimension() as number,
    }
  }

  /** Close the underlying connection. */
  close(): void {
    this.store.close()
  }

  private count(): NaruStatus['counts'] {
    const one = (table: string): number => {
      const row = this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number
      }
      return row.n
    }
    return {
      facts: one('facts'),
      entities: one('entities'),
      episodes: one('episodes'),
      scopes: one('scopes'),
    }
  }

  /** Current `facts` row count (privacy-safe; used to infer add-dedupe outcome). */
  private factCount(): number {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }
    return row.n
  }

  /**
   * Emit a `search` event carrying only the query SHAPE (its length) and result
   * count — never the query text itself, which can contain sensitive material.
   */
  private emitSearch(
    input: SearchInput,
    resultCount: number,
    hybrid: boolean,
    start: number | null,
  ): void {
    if (!this.logger.enabled) {
      return
    }
    const event: SearchEvent = {
      operation: 'search',
      level: 'debug',
      queryLength: input.query.length,
      resultCount,
      hybrid,
    }
    const ms = this.elapsed(start)
    if (ms !== undefined) {
      event.durationMs = ms
    }
    if (input.scope) {
      event.scope = { type: input.scope.type, key: input.scope.key }
    }
    this.logger.emit(event)
  }

  /** Start a monotonic timer, or `null` when observability is off (no cost). */
  private startTimer(): number | null {
    return this.logger.enabled ? performance.now() : null
  }

  /** Elapsed ms since {@link startTimer}, rounded; `undefined` when untimed. */
  private elapsed(start: number | null): number | undefined {
    return start === null ? undefined : Math.round(performance.now() - start)
  }
}

/** Outcome of {@link Naru.backupTo}: snapshot path/size + verified canonical counts. */
export interface BackupOutcome {
  /** Absolute path of the written snapshot. */
  path: string
  /** Snapshot file size in bytes. */
  bytes: number
  /** Whether the snapshot's canonical `facts`/`scopes` counts matched the source. */
  verified: boolean
  /** Verified canonical counts read back from the snapshot. */
  counts: NaruStatus['counts']
}

/** Count rows in a canonical table via a store's connection (backup verify). */
function countTable(store: Store, table: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

/** Per-table row counts of a bundle for an `export` event (counts only). */
function bundleCounts(bundle: MemoryBundle): Record<string, number> {
  return {
    scopes: bundle.scopes.length,
    episodes: bundle.episodes.length,
    entities: bundle.entities.length,
    facts: bundle.facts.length,
    evidence: bundle.evidence.length,
    edges: bundle.edges.length,
    supersessions: bundle.supersessions.length,
  }
}
