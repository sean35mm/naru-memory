import {
  type Entity,
  type Episode,
  type Evidence,
  type Fact,
  type FactStatus,
  type SearchResultItem,
  type SourceType,
  type Supersession,
  newEvidenceId,
  newFactId,
  newSupersessionId,
  nowIso,
  sha256Hex,
  statementHash,
} from '@naru/schema'
import type { FactSearchHit, Store } from '@naru/store-sqlite'
import type { EmbedderProvider } from './embedding'
import { extractEntities, linkEntities, normalizeEntityName } from './entity-linking'
import { EpisodeService } from './episode-service'
import type { ExtractedFact, ExtractorProvider, ReconcileDecision } from './extraction'
import { redact } from './redaction'
import type { ScopeSelector, ScopeService, WritableScopeSelector } from './scope-service'

const EXTRACTOR_NAME = 'manual'
const EXTRACTOR_VERSION = '1'

/** Extractor version recorded in evidence when an LLM/mock extractor is used. */
const LLM_EXTRACTOR_VERSION = '1'

/** Max related active facts handed to {@link ExtractorProvider.reconcile}. */
const RECONCILE_RELATED_LIMIT = 20

/** Input for {@link MemoryService.addManual} (plan §13.3, `infer=false`). */
export interface AddManualInput {
  text: string
  /** Write scope; `global` is not a write target (plan §9.2). */
  scope: WritableScopeSelector
  subject?: string
  predicate?: string
  object?: string
  confidence?: number
  sourceType?: SourceType
}

/** Input for {@link MemoryService.captureAndExtract} (plan §13 ADD-only pipeline). */
export interface CaptureAndExtractInput {
  text: string
  /** Write scope; `global` is not a write target (plan §9.2). */
  scope: WritableScopeSelector
  sourceType?: SourceType
  sourceRef?: string | null
  observedAt?: string
}

/** Result of {@link MemoryService.captureAndExtract}: the episode + touched facts. */
export interface CaptureResult {
  episode: Episode
  /** Facts created or updated (active replacements / dedupe targets) this run. */
  facts: Fact[]
}

/**
 * Resolved triple/statement/hash for one extracted candidate plus the dedupe
 * decision computed against existing facts. Decisions that need the provider's
 * `reconcile` are made outside the write transaction; the commit step only
 * applies them. {@link entityNames} are normalized keys used to (re)resolve
 * entity rows during commit.
 */
interface ExtractedFactPlan {
  extracted: ExtractedFact
  subject: string
  predicate: string
  objectValue: string
  statement: string
  statementHash: string
  entityNames: string[]
  decision:
    | { kind: 'duplicate' | 'supersedes'; targetFactId: string; reason?: string }
    | { kind: 'new' }
}

/** Input for {@link MemoryService.search} (plan §14). */
export interface SearchInput {
  query: string
  scope?: ScopeSelector
  scopes?: ScopeSelector[]
  global?: boolean
  /**
   * Bound a `global` read to a single user (plan §9.1/§9.3). Forwarded to
   * {@link ScopeService.resolveAllowedScopes} so the `user`-typed half of the
   * global expansion is the requesting user's only — preventing cross-user
   * `user`-scope leakage on a shared DB. No effect unless `global` is set.
   */
  globalUser?: string
  limit?: number
  /** Include superseded facts / history (plan §14.3). */
  includeHistory?: boolean
}

/**
 * Named, config-exposed weights for the hybrid ranker (plan §14.2 "combination
 * methodology"). The combined score is a weighted-linear sum of per-signal
 * values each normalized to [0,1] over the candidate set, so the weights are
 * directly comparable. Treat {@link DEFAULT_RANKING_WEIGHTS} as a checked-in
 * artifact tuned against the retrieval eval set (§21.7), revisited when signals
 * change — not magic numbers buried in the ranker.
 */
export interface RankingWeights {
  /** Lexical BM25 relevance (FTS), normalized min-max over the candidate set. */
  bm25: number
  /** Semantic vector cosine similarity (0 when no embedder is configured). */
  vectorCosine: number
  /** Query-entity match strength (fraction of query entities the fact links). */
  entityMatch: number
  /** Recency of `observed_at` (decays over ~1 year). */
  recency: number
  /** Fact confidence in [0,1]. */
  confidence: number
  /** Scope priority weight (user/project/... ranked per §9.3). */
  scopeWeight: number
}

/**
 * Default ranking weights (plan §14.2). BM25 and vector cosine carry the most
 * weight as the two primary relevance signals; scope priority is a strong
 * preference, recency/confidence are tie-breakers. Out-of-scope and superseded
 * facts are excluded by the §9.4 gate BEFORE ranking, so no weight can rank one
 * in — these weights only order the already-allowed current-view candidates.
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  bm25: 0.35,
  vectorCosine: 0.3,
  entityMatch: 0.1,
  scopeWeight: 0.15,
  recency: 0.05,
  confidence: 0.05,
}

/** Input for {@link MemoryService.buildContext} (plan §14.4 `context.build`). */
export interface BuildContextInput extends SearchInput {
  /** Token budget the assembled `promptBlock` must not exceed (default 1024). */
  tokenBudget?: number
}

/** One packed context item (plan §14.4 output shape). */
export interface ContextItem {
  factId: string
  statement: string
  /** Scope key (`type:key`). */
  scope: string
  score: number
  evidenceRefs: string[]
  temporal: { validFrom: string | null; validTo: string | null }
  /** Per-signal contributions that ranked this item in (plan §14.2/§14.4). */
  reason: string[]
}

/** Structured, token-bounded context (plan §14.4 `context.build`). */
export interface BuildContextResult {
  items: ContextItem[]
  /** Rendered prompt block; its `tokenEstimate` never exceeds the budget. */
  promptBlock: string
  tokenEstimate: number
}

/** A candidate fact accumulated across the hybrid candidate sources (§14.1). */
interface Candidate {
  fact: Fact
  reasons: Set<string>
  /** Raw SQLite bm25 score (lower = more relevant); absent for non-FTS hits. */
  bm25?: number
  /** Raw cosine similarity in [-1,1]; absent for non-vector hits. */
  cosine?: number
}

/** A ranked candidate carrying its final score + the scope-key lookup map. */
interface RankedCandidate {
  fact: Fact
  reasons: string[]
  score: number
  scopeKeyById: Map<string, string>
}

/** Input for {@link MemoryService.list}. */
export interface ListInput {
  scope?: ScopeSelector
  status?: FactStatus
  limit?: number
}

/** A fact with its evidence (plan §15.2 `fact.get`). */
export interface FactWithEvidence {
  fact: Fact
  evidence: Evidence[]
}

/** An entity with its linked active facts (plan §15.2 `entity.get`). */
export interface EntityWithFacts {
  entity: Entity
  facts: Fact[]
}

/** Selector for destructive privacy purge (plan §18.2). */
export interface ForgetSelector {
  factId?: string
  entityId?: string
  episodeId?: string
  scope?: ScopeSelector
  before?: string
  after?: string
}

/** One link in a supersession chain plus the resolved fact (plan §14.3). */
export interface HistoryEntry {
  fact: Fact
  supersededBy: string | null
  supersedes: string | null
}

const DEFAULT_PREDICATE = 'states'
const DEFAULT_CONFIDENCE = 1
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_LIST_LIMIT = 50
/** Default token budget for {@link MemoryService.buildContext} (plan §14.4). */
const DEFAULT_TOKEN_BUDGET = 1024
/**
 * Vector-candidate overfetch multiplier. KNN returns this * limit candidates so
 * the hybrid union/normalize step has headroom before the final top-`limit` cut.
 */
const CANDIDATE_OVERFETCH = 4

/**
 * Core memory operations (plan §13, §14, §18).
 *
 * ADD-only at the storage boundary (plan §13): manual adds redact first, dedupe
 * by `statement_hash` within scope, then persist fact + evidence + linked
 * entities and index into FTS. Search enforces the §9.4 safe pattern: resolve
 * the allowed scope set FIRST, retrieve candidates only within those scopes,
 * apply the current-view filter, THEN rank.
 */
export class MemoryService {
  private readonly episodes: EpisodeService

  private readonly weights: RankingWeights

  constructor(
    private readonly store: Store,
    private readonly scopeService: ScopeService,
    private readonly defaultRetention: 'redacted' | 'minimal' | 'encrypted' | 'none' = 'redacted',
    /**
     * Optional LLM extraction provider (plan §6.2, §13.2). When `null`/unset,
     * extraction is UNAVAILABLE: {@link captureAndExtract} stores the redacted
     * episode and falls back to a single `infer=false` manual fact (plan §13.3).
     */
    private readonly extractor: ExtractorProvider | null = null,
    /**
     * Optional embedder provider (plan §6.2, §11.9, M3). When `null`/unset,
     * vector retrieval is OFF: {@link search} uses only BM25/entity/recency and
     * write paths skip vector indexing (no regression vs M1/M2).
     */
    private readonly embedder: EmbedderProvider | null = null,
    /** Hybrid ranking weights (plan §14.2); defaults to {@link DEFAULT_RANKING_WEIGHTS}. */
    rankingWeights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
  ) {
    this.episodes = new EpisodeService(store, this.defaultRetention)
    this.weights = rankingWeights
  }

  /** Whether an LLM/mock extractor is configured (plan §13.3 status surface). */
  hasExtractor(): boolean {
    return this.extractor !== null
  }

  /** Configured extractor name, or `undefined` when unavailable. */
  extractorName(): string | undefined {
    return this.extractor?.name
  }

  /** Whether a vector embedder is configured (plan §6.2 status/capability). */
  hasEmbedder(): boolean {
    return this.embedder !== null
  }

  /** Configured embedder name, or `undefined` when vector retrieval is OFF. */
  embedderName(): string | undefined {
    return this.embedder?.name
  }

  /** Configured embedder output dimension, or `undefined` when OFF. */
  embedderDimension(): number | undefined {
    return this.embedder?.dimension
  }

  /** Configured embedder model identity, or `undefined` when OFF. */
  embedderModel(): string | undefined {
    return this.embedder?.model
  }

  /**
   * Add a manual memory with `infer=false` (plan §13.3).
   *
   * Redacts text first (plan §18.1). The statement is the composed S/P/O when a
   * predicate/object are supplied, otherwise the redacted text. The portable
   * `statement_hash` is computed from `(scopeKey, subject, predicate,
   * object||statement)`. If an ACTIVE fact with the same hash already exists in
   * scope, it is returned unchanged (idempotent). If the hash only matches a
   * SUPERSEDED fact, the statement was explicitly replaced (plan §13.6/§14.3):
   * re-adding must not resurrect it, so the active replacement at the end of
   * the supersession chain is returned instead of inserting a fresh active
   * duplicate. Otherwise a manual episode + evidence are created, entities
   * extracted/linked, and the fact inserted and indexed into `facts_fts`.
   *
   * VECTOR INDEXING (plan §11.9, §13.2): when an embedder is configured AND a
   * NEW fact was inserted this call, its (already-redacted) statement is embedded
   * and its vector upserted. Because `addManual` is synchronous (the store API is
   * sync) and embedding may be a remote/async call, the embed runs as a
   * fire-and-forget background task AFTER the canonical write commits — the fact
   * + FTS row are durable regardless of the embed outcome (writes async,
   * capture-never-fails, plan §13.2/§6.2). Tests that need the vector present
   * deterministically should await {@link reindexVectors}. Dedupe hits (an
   * existing active/replacement fact) are not re-embedded — their vector already
   * exists (or is produced by a deliberate reindex).
   */
  addManual(input: AddManualInput): Fact {
    const scope = this.scopeService.ensureScope(input.scope.type, input.scope.key)
    const { redacted: redactedText } = redact(input.text)
    const subject = input.subject ? redact(input.subject).redacted : null
    const predicate = input.predicate ? redact(input.predicate).redacted : DEFAULT_PREDICATE
    const objectValue = input.object ? redact(input.object).redacted : null

    const statement =
      input.predicate && (input.object || input.subject)
        ? [subject, predicate, objectValue].filter((p): p is string => !!p).join(' ')
        : redactedText

    const hash = statementHash({
      scopeKey: scope.key,
      subject,
      predicate,
      object: objectValue ?? statement,
    })

    let inserted: Fact | undefined
    const fact = this.store.transaction(() => {
      // Dedupe on the supersession-aware state, not just status === 'active'
      // (plan §13.5/§13.6). An existing active row is returned idempotently.
      const existingActive = this.store.facts.getActiveByStatementHash(scope.id, hash)
      if (existingActive) {
        return existingActive
      }
      // No active row, but a superseded one with this hash means the statement
      // was explicitly replaced. Do NOT insert a fresh active duplicate that
      // would resurrect it in the current view: return the active replacement
      // at the end of its supersession chain, if one still exists.
      const replacement = this.findActiveReplacement(scope.id, hash)
      if (replacement) {
        return replacement
      }

      const now = nowIso()
      const sourceType = input.sourceType ?? 'manual'
      const episode = this.episodes.capture({
        text: statement,
        scope,
        sourceType,
      })

      const extracted = extractEntities(statement)
      const entities = linkEntities(this.store, scope.id, extracted)
      const subjectEntity = subject ? this.findEntityByName(entities, subject) : undefined
      const objectEntity = objectValue ? this.findEntityByName(entities, objectValue) : undefined

      const fact: Fact = {
        id: newFactId(),
        scopeId: scope.id,
        subjectEntityId: subjectEntity?.id ?? null,
        predicate,
        objectEntityId: objectEntity?.id ?? null,
        objectValue: objectEntity ? null : objectValue,
        statement,
        statementHash: hash,
        confidence: input.confidence ?? DEFAULT_CONFIDENCE,
        status: 'active',
        validFrom: null,
        validTo: null,
        observedAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: {},
      }
      this.store.facts.insert(fact)

      const evidence: Evidence = {
        id: newEvidenceId(),
        factId: fact.id,
        episodeId: episode.id,
        spanStart: null,
        spanEnd: null,
        redactedQuote: episode.redactedText,
        quoteHash: null,
        extractorName: EXTRACTOR_NAME,
        extractorVersion: EXTRACTOR_VERSION,
        createdAt: now,
      }
      this.store.evidence.insert(evidence)

      const entityText = this.buildEntityText(entities, objectValue)
      this.store.facts.indexFact(fact, scope.key, entityText)

      inserted = fact
      return fact
    })

    // Embed the NEW fact AFTER the write commits (plan §13.2 writes async). The
    // embedder may be remote, so this is fire-and-forget: the fact + FTS row are
    // already durable, and a failed/slow embed must never fail the add or block
    // the sync return. No-op when no embedder is configured or this was a dedupe
    // hit (no new fact inserted). `embedAndStore` swallows its own errors.
    if (inserted) {
      void this.embedAndStore([inserted])
    }
    return fact
  }

  /**
   * Extraction-driven ingestion (plan §13 ADD-only pipeline, LLM tier).
   *
   * Pipeline: ensure scope -> REDACT FIRST (plan §18.1/§10.2) -> store the
   * redacted episode -> hand the REDACTED text to the configured extractor ->
   * for each extracted candidate: link entities (scope-aware), compose the
   * statement + portable `statement_hash`, then DEDUPE/RECONCILE:
   *   1. exact `statement_hash` within scope: an existing active row is a
   *      duplicate -> attach evidence to it (plan §13.5), skip insert; a
   *      hash that only matches a superseded chain resolves to the active
   *      replacement (do not resurrect, plan §13.6) and attaches evidence there.
   *   2. otherwise gather related active facts (by linked entities + FTS) and
   *      call the extractor's `reconcile` (plan §13.5/§13.6):
   *        - `duplicate` -> attach evidence to the target, skip insert;
   *        - `supersedes` -> insert the new active fact + supersede the target;
   *        - `new`/absent -> insert as a fresh active fact.
   * Every inserted/targeted fact gets an evidence row (redacted quote + span +
   * `quote_hash`, `extractor_name` = provider name) and the new facts are
   * indexed into `facts_fts`.
   *
   * RESILIENCE (plan §13.3): if no extractor is configured, or the provider
   * throws, capture NEVER fails — the redacted episode is still stored and a
   * single manual `infer=false` fact is created from the redacted text so the
   * episode is never lost to an LLM error.
   */
  async captureAndExtract(input: CaptureAndExtractInput): Promise<CaptureResult> {
    const scope = this.scopeService.ensureScope(input.scope.type, input.scope.key)
    // REDACT FIRST: the same redacted text is persisted as the episode AND is the
    // only text ever handed to the extractor (which may reach a remote endpoint).
    const { redacted: redactedText } = redact(input.text)
    const sourceType = input.sourceType ?? 'chat'
    const observedAt = input.observedAt ?? nowIso()

    // Store the (redacted) episode up front so it survives any extractor failure.
    const episode = this.store.transaction(() =>
      this.episodes.capture({
        text: redactedText,
        scope,
        sourceType,
        sourceRef: input.sourceRef ?? null,
        observedAt,
      }),
    )

    // No extractor configured -> fall back to a single manual fact (plan §13.3).
    if (!this.extractor) {
      const facts = this.fallbackManualFacts(scope.id, scope.key, episode, observedAt)
      await this.embedAndStore(facts)
      return { episode, facts }
    }

    let extracted: ExtractedFact[]
    try {
      extracted = await this.extractor.extract({
        text: redactedText,
        observedAt,
        scopeKey: scope.key,
      })
    } catch {
      // Provider failed/threw -> never lose the episode (plan §13.3): fall back.
      return { episode, facts: this.fallbackManualFacts(scope.id, scope.key, episode, observedAt) }
    }

    // Reconcile decisions need the (possibly remote) provider, so they run
    // OUTSIDE the SQLite transaction; the resulting writes are batched into one
    // transaction below. Pre-compute candidate + decision per extracted fact.
    const extractorName = this.extractor.name
    const plans = await this.planExtractedFacts(scope.id, scope.key, observedAt, extracted)

    // Commit all extracted writes in ONE transaction. Defense-in-depth (plan
    // §13.3): any unexpected store error here (e.g. a constraint violation from
    // adversarial provider output that survived parsing) must NOT abort the
    // capture or lose the already-stored episode — fall back to a single manual
    // fact so capture() always resolves with a CaptureResult.
    let facts: Fact[]
    try {
      facts = this.store.transaction(() =>
        this.commitExtractedFacts(scope.id, scope.key, episode, observedAt, extractorName, plans),
      )
    } catch {
      facts = this.fallbackManualFacts(scope.id, scope.key, episode, observedAt)
    }
    // Embed the touched facts AFTER the write transaction (the embedder may be a
    // remote call, must not hold the SQLite lock). Embedding failure is
    // non-fatal: vectors are a derived/rebuildable index (plan §12.2) and search
    // degrades to lexical/entity retrieval (plan §6.2), so capture still succeeds.
    await this.embedAndStore(facts)
    return { episode, facts }
  }

  /**
   * Hybrid memory search (plan §14) enforcing the §9.4 safe pattern.
   *
   * (1) resolve the allowed scope set FIRST; (2) gather candidates ONLY within
   * those scope keys from FTS/BM25 + entity matches + (when an embedder is
   * configured) vector KNN — embedding the query and running KNN restricted to
   * the allowed scopes so semantic similarity can never pull a cross-scope fact;
   * union the candidate set; (3) apply the current-view filter (exclude
   * deleted/rejected, and superseded unless `includeHistory`); (4) THEN rank with
   * a NORMALIZED weighted-linear score over bm25, vectorCosine, entityMatch,
   * recency, confidence, scopeWeight (plan §14.2). Each signal is normalized to
   * [0,1] over the candidate set before combining; scope + current-view act as
   * gates upstream (step 1/3), never as a term that could rank an out-of-scope
   * or superseded fact in. Per-signal contributions land in `reasons[]`.
   *
   * This entry point is SYNCHRONOUS and therefore does NOT embed the query (the
   * embedder is async): with an embedder configured, it ranks lexical/entity
   * candidates only. Use the async {@link searchHybrid} (and {@link buildContext})
   * to include the semantic vector signal. With no embedder configured both
   * behave identically to the M1/M2 lexical search — no regression.
   */
  search(input: SearchInput): SearchResultItem[] {
    return this.rankCandidates(input, undefined).map((r) =>
      this.toResultItem(r.fact, r.reasons, r.score, r.scopeKeyById),
    )
  }

  /**
   * Async hybrid search (plan §14): identical to {@link search} but embeds the
   * query through the (possibly remote) embedder so the vector signal is used
   * even with an async/network embedder. Falls back to lexical/entity retrieval
   * when no embedder is configured or the embed call fails (plan §6.2 graceful
   * degradation — never throws the whole search away on an embed error).
   */
  async searchHybrid(input: SearchInput): Promise<SearchResultItem[]> {
    const queryVec = await this.embedQuery(input.query)
    return this.rankCandidates(input, queryVec).map((r) =>
      this.toResultItem(r.fact, r.reasons, r.score, r.scopeKeyById),
    )
  }

  /**
   * Core hybrid pipeline shared by {@link search} (no query vector) and
   * {@link searchHybrid} (query vector supplied). When `queryVec` is provided and
   * an embedder is configured, vector KNN candidates (scope-filtered in SQL) are
   * unioned in and the cosine signal participates in ranking.
   */
  private rankCandidates(
    input: SearchInput,
    queryVec: Float32Array | undefined,
  ): RankedCandidate[] {
    const resolved = this.scopeService.resolveAllowedScopes({
      scope: input.scope,
      scopes: input.scopes,
      global: input.global,
      ...(input.globalUser !== undefined ? { globalUser: input.globalUser } : {}),
    })
    const scopeKeyById = new Map(resolved.scopes.map((s) => [s.id, s.key]))
    if (resolved.scopeKeys.length === 0) {
      return []
    }
    const allowedScopeIds = new Set(resolved.scopes.map((s) => s.id))
    const scopeTypeById = new Map(resolved.scopes.map((s) => [s.id, s.type]))
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const fetch = limit * CANDIDATE_OVERFETCH

    // (2) candidate retrieval inside allowed scopes only.
    const candidates = new Map<string, Candidate>()
    const get = (fact: Fact): Candidate => {
      const existing = candidates.get(fact.id)
      if (existing) {
        return existing
      }
      const created: Candidate = { fact, reasons: new Set<string>() }
      candidates.set(fact.id, created)
      return created
    }

    const ftsQuery = buildFtsMatch(input.query)
    if (ftsQuery) {
      const hits: FactSearchHit[] = this.store.facts.ftsSearch(resolved.scopeKeys, ftsQuery, fetch)
      for (const hit of hits) {
        const entry = get(hit.fact)
        entry.reasons.add('bm25')
        entry.bm25 = hit.bm25
      }
    }

    // entity match: extracted query entities -> facts referencing those entities
    // within the allowed scopes only (plan §18.3 — collect in-scope facts only).
    const queryEntities = extractEntities(input.query)
    const queryEntityKeys = queryEntities.map((e) => normalizeEntityName(e.name))
    if (queryEntityKeys.length > 0) {
      for (const fact of this.factsByEntityNames(queryEntityKeys, allowedScopeIds)) {
        get(fact).reasons.add('entity')
      }
    }

    // vector KNN candidates (plan §14.1): only when an embedder is configured AND
    // a query vector was produced. `store.vectors.knn` filters to the allowed
    // scope keys + active status IN THE SQL, so cosine can never surface a
    // cross-scope/superseded fact (plan §9.4/§18.3 — retrieve in-scope only).
    if (this.embedder && queryVec && queryVec.length > 0) {
      const match = { provider: this.embedder.name, model: this.embedder.model }
      for (const hit of this.store.vectors.knn(resolved.scopeKeys, queryVec, fetch, match)) {
        const fact = this.store.facts.getById(hit.factId)
        if (fact) {
          const entry = get(fact)
          entry.reasons.add('vector')
          entry.cosine = hit.score
        }
      }
    }

    // (3) current-view filter (plan §14.3).
    const supersededOldIds = this.supersededOldFactIds()
    const filtered = [...candidates.values()].filter((c) => {
      if (!allowedScopeIds.has(c.fact.scopeId)) {
        return false
      }
      if (c.fact.status === 'deleted' || c.fact.status === 'rejected') {
        return false
      }
      if (!input.includeHistory) {
        if (c.fact.status === 'superseded') {
          return false
        }
        // active-but-superseded edge case: hide if an active replacement exists.
        if (supersededOldIds.has(c.fact.id)) {
          return false
        }
      }
      return true
    })

    // (4) rank: NORMALIZED weighted-linear combination (plan §14.2). Normalize
    // bm25 and cosine per candidate set (different scales) before combining.
    const bm25Values = filtered.map((c) => c.bm25).filter((v): v is number => typeof v === 'number')
    const cosineValues = filtered
      .map((c) => c.cosine)
      .filter((v): v is number => typeof v === 'number')
    const w = this.weights
    const ranked = filtered.map((c) => {
      const reasons = new Set(c.reasons)
      const scopeType = scopeTypeById.get(c.fact.scopeId)
      const scopeWeight = scopeType
        ? this.scopeService.rankWeight(scopeType) / SCOPE_RANK_DIVISOR
        : 0
      if (scopeType) {
        reasons.add(`scope:${scopeType}`)
      }
      const bm25Score = normalizeBm25(c.bm25, bm25Values)
      const cosineScore = normalizeCosine(c.cosine, cosineValues)
      const entityScore = entityMatchScore(c, queryEntityKeys.length)
      const recency = recencyScore(c.fact.observedAt)
      if (recency > 0) {
        reasons.add('recency')
      }
      const confidence = clamp01(c.fact.confidence)

      const score =
        w.bm25 * bm25Score +
        w.vectorCosine * cosineScore +
        w.entityMatch * entityScore +
        w.scopeWeight * scopeWeight +
        w.recency * recency +
        w.confidence * confidence
      return { fact: c.fact, reasons: [...reasons], score, scopeKeyById }
    })

    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, limit)
  }

  /**
   * Build token-bounded structured context (plan §14.4 `context.build`).
   *
   * Runs the async hybrid {@link searchHybrid} (so the vector signal is used when
   * an embedder is configured), then packs the top-ranked items into a
   * `promptBlock` greedily until adding the next item would exceed `tokenBudget`
   * (default {@link DEFAULT_TOKEN_BUDGET}). The returned `tokenEstimate` NEVER
   * exceeds the budget. Items carry their per-signal `reason`. Returns an empty
   * result (no items, empty block, 0 tokens) when no scope is allowed (§9.4).
   */
  async buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    const hits = await this.searchHybrid(input)
    return packContext(hits, budget)
  }

  /**
   * (Re)embed every active fact within retained scopes and upsert its vector
   * (plan §12.2 deliberate vector rebuild). No-op when no embedder is configured.
   * This is the awaitable backfill that populates vectors for facts added via the
   * synchronous {@link addManual} path; the async {@link captureAndExtract} path
   * embeds inline. Embedding the (already-redacted) `statement` keeps §18.1.
   */
  async reindexVectors(): Promise<{ embedded: number }> {
    if (!this.embedder) {
      return { embedded: 0 }
    }
    // Enumerate active facts directly from `facts`, NOT by walking `scopes.list()`
    // (plan §22/§12.2): a canonical fact whose `scope_id` references a missing
    // scope (corruption / partial restore) would be skipped by a scopes-driven
    // walk and left permanently absent from the vector index. Listing by status
    // re-embeds every active fact regardless of scope-row presence.
    const facts = this.store.facts.listAllByStatus('active')
    await this.embedAndStore(facts)
    return { embedded: facts.length }
  }

  /** List facts by scope/status (plan §15.2 `memory.list`). */
  list(input: ListInput = {}): Fact[] {
    const status = input.status ?? 'active'
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    if (input.scope) {
      const scope = this.store.scopes.getByKey(`${input.scope.type}:${input.scope.key}`)
      if (!scope) {
        return []
      }
      return this.store.facts.listByScopeStatus(scope.id, status).slice(0, limit)
    }
    const out: Fact[] = []
    for (const scope of this.store.scopes.list()) {
      out.push(...this.store.facts.listByScopeStatus(scope.id, status))
    }
    out.sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))
    return out.slice(0, limit)
  }

  /** Retrieve one fact with its evidence (plan §15.2 `fact.get`). */
  get(id: string): FactWithEvidence | undefined {
    const fact = this.store.facts.getById(id)
    if (!fact) {
      return undefined
    }
    return { fact, evidence: this.store.evidence.listByFact(id) }
  }

  /**
   * List entities (plan §15.2 `entity.list`). When a scope selector is given,
   * returns only entities owned by that scope row (none if it does not exist).
   * With no selector, returns entities across every scope plus any explicitly
   * promoted global entities (`scope_id IS NULL`, plan §11.4).
   */
  listEntities(scope?: ScopeSelector): Entity[] {
    if (scope) {
      const resolved = this.store.scopes.getByKey(`${scope.type}:${scope.key}`)
      if (!resolved) {
        return []
      }
      return this.store.entities.listByScope(resolved.id)
    }
    const out: Entity[] = []
    for (const s of this.store.scopes.list()) {
      out.push(...this.store.entities.listByScope(s.id))
    }
    out.push(...this.store.entities.listByScope(null))
    return out
  }

  /**
   * Retrieve one entity with its linked active facts (plan §15.2 `entity.get`):
   * facts referencing the entity as subject or object, filtered to the current
   * view (`status = 'active'`). Returns undefined if the entity does not exist.
   */
  getEntity(id: string): EntityWithFacts | undefined {
    const entity = this.store.entities.getById(id)
    if (!entity) {
      return undefined
    }
    const rows = this.store.db
      .prepare(
        `SELECT id FROM facts
          WHERE (subject_entity_id = ? OR object_entity_id = ?)
            AND status = 'active'
          ORDER BY observed_at DESC`,
      )
      .all(id, id) as { id: string }[]
    const facts: Fact[] = []
    for (const row of rows) {
      const fact = this.store.facts.getById(row.id)
      if (fact) {
        facts.push(fact)
      }
    }
    return { entity, facts }
  }

  /**
   * Destructive privacy purge (plan §18.2). Resolves the selector to a set of
   * facts and deletes each fact plus its evidence, edges, supersession links,
   * and `facts_fts` row; then prunes entities that became orphaned (and their
   * `entities_fts` rows) and episodes that became wholly orphaned (no surviving
   * evidence references them). When `episodeId` is given, that episode is purged
   * directly. Returns the count of facts deleted.
   */
  forget(selector: ForgetSelector): { deleted: number } {
    return this.store.transaction(() => {
      const factIds = this.resolveForgetFactIds(selector)
      const touchedEntityIds = new Set<string>()
      const touchedEpisodeIds = new Set<string>()

      for (const factId of factIds) {
        const fact = this.store.facts.getById(factId)
        if (!fact) {
          continue
        }
        if (fact.subjectEntityId) {
          touchedEntityIds.add(fact.subjectEntityId)
        }
        if (fact.objectEntityId) {
          touchedEntityIds.add(fact.objectEntityId)
        }
        // Capture the source episodes BEFORE deleting evidence so we can prune
        // any that become unreachable (carrying redacted source text, §18.2).
        for (const episodeId of this.store.evidence.episodeIdsByFact(factId)) {
          touchedEpisodeIds.add(episodeId)
        }
        this.store.evidence.deleteByFact(factId)
        this.store.supersessions.deleteByFact(factId)
        this.store.edges.deleteBySourceOrTarget('fact', factId)
        this.store.facts.deleteById(factId)
      }

      // Prune entities that no longer back any fact.
      for (const entityId of touchedEntityIds) {
        if (!this.entityHasFacts(entityId)) {
          this.store.edges.deleteBySourceOrTarget('entity', entityId)
          this.store.entities.deleteById(entityId)
        }
      }

      if (selector.episodeId) {
        touchedEpisodeIds.add(selector.episodeId)
        this.store.episodes.deleteById(selector.episodeId)
      }

      // Prune episodes that no longer back any surviving evidence so the
      // redacted source text does not linger unreachable (plan §18.2).
      for (const episodeId of touchedEpisodeIds) {
        if (!this.store.evidence.hasEpisode(episodeId)) {
          this.store.episodes.deleteById(episodeId)
        }
      }

      return { deleted: factIds.length }
    })
  }

  /**
   * Manually supersede `oldId` with `newId` (plan §13.6): mark the old fact
   * `superseded`, insert a supersession link, keep the new fact active. The
   * current view then returns the new fact; history shows both.
   */
  supersede(oldId: string, newId: string, reason?: string): Supersession {
    return this.store.transaction(() => {
      const oldFact = this.store.facts.getById(oldId)
      const newFact = this.store.facts.getById(newId)
      if (!oldFact) {
        throw new Error(`supersede: old fact not found: ${oldId}`)
      }
      if (!newFact) {
        throw new Error(`supersede: new fact not found: ${newId}`)
      }
      this.store.facts.updateStatus(oldId, 'superseded')
      const supersession: Supersession = {
        id: newSupersessionId(),
        oldFactId: oldId,
        newFactId: newId,
        reason: reason ?? null,
        confidence: null,
        createdAt: nowIso(),
      }
      return this.store.supersessions.insert(supersession)
    })
  }

  /**
   * Supersession chain for a fact (plan §14.3 history view). Walks backward to
   * the chain root then forward, returning each fact with its prev/next link.
   */
  history(factId: string): HistoryEntry[] {
    const root = this.findChainRoot(factId)
    if (!root) {
      return []
    }
    const entries: HistoryEntry[] = []
    const visited = new Set<string>()
    let currentId: string | null = root
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const fact = this.store.facts.getById(currentId)
      if (!fact) {
        break
      }
      const forward = this.store.supersessions.listByOld(currentId)
      const backward = this.store.supersessions.listByNew(currentId)
      const supersededBy = forward[0]?.newFactId ?? null
      const supersedes = backward[0]?.oldFactId ?? null
      entries.push({ fact, supersededBy, supersedes })
      currentId = supersededBy
    }
    return entries
  }

  /** Capture a raw episode (plan §13.1) without fact extraction (M1 seam). */
  captureEpisode(input: {
    text: string
    scope: WritableScopeSelector
    sourceType: SourceType
    sourceRef?: string | null
    observedAt?: string
  }) {
    const scope = this.scopeService.ensureScope(input.scope.type, input.scope.key)
    return this.episodes.capture({
      text: input.text,
      scope,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      observedAt: input.observedAt,
    })
  }

  /**
   * Rebuild ALL derived indexes from canonical rows (plan §12.2 rebuildability).
   *
   * Always rebuilds the FTS tables (cheap, drop-and-recreate). When an embedder
   * is configured, ALSO rebuilds the vector index: the existing vectors are
   * dropped and every active fact is re-embedded from its (already-redacted)
   * `statement`, proving vectors regenerate from canonical facts (plan §12.2 —
   * re-embedding has real compute cost, so this is a deliberate operation, not a
   * routine drop). With no embedder configured the vector step is skipped (the
   * vector index stays empty / OFF). Async because re-embedding may be remote.
   */
  async reindex(): Promise<void> {
    this.store.rebuildFts()
    if (this.embedder) {
      this.store.vectors.clearVectors()
      await this.reindexVectors()
    }
  }

  // --- internals --------------------------------------------------------

  /**
   * Fallback ingestion (plan §13.3): no extractor / provider error. Creates a
   * single `infer=false`-style manual fact from the episode's redacted text so
   * the episode is never lost. Reuses the same dedupe discipline as
   * {@link addManual}: idempotent on an existing active hash, never resurrects a
   * superseded chain. Runs in its own transaction. Returns [] if the episode
   * carries no redacted body (e.g. `minimal`/`none` retention) — nothing to add.
   */
  private fallbackManualFacts(
    scopeId: string,
    scopeKey: string,
    episode: Episode,
    observedAt: string,
  ): Fact[] {
    const statement = episode.redactedText
    if (!statement || statement.trim().length === 0) {
      return []
    }
    const predicate = DEFAULT_PREDICATE
    const hash = statementHash({ scopeKey, subject: null, predicate, object: statement })

    return this.store.transaction(() => {
      const existingActive = this.store.facts.getActiveByStatementHash(scopeId, hash)
      if (existingActive) {
        this.attachEvidence(
          existingActive.id,
          episode,
          null,
          statement,
          EXTRACTOR_NAME,
          EXTRACTOR_VERSION,
        )
        return [existingActive]
      }
      const replacement = this.findActiveReplacement(scopeId, hash)
      if (replacement) {
        this.attachEvidence(
          replacement.id,
          episode,
          null,
          statement,
          EXTRACTOR_NAME,
          EXTRACTOR_VERSION,
        )
        return [replacement]
      }

      const entities = linkEntities(this.store, scopeId, extractEntities(statement))
      const fact = this.insertFact({
        scopeId,
        subjectEntityId: null,
        predicate,
        objectEntityId: null,
        objectValue: null,
        statement,
        statementHash: hash,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
        validFrom: null,
        validTo: null,
      })
      this.attachEvidence(fact.id, episode, null, statement, EXTRACTOR_NAME, EXTRACTOR_VERSION)
      this.store.facts.indexFact(fact, scopeKey, this.buildEntityText(entities, null))
      return [fact]
    })
  }

  /**
   * Resolve each extracted candidate to a triple/statement/hash and decide its
   * dedupe action (plan §13.5/§13.6) BEFORE the write transaction. Exact-hash
   * matches are decided synchronously; the rest call the provider's `reconcile`
   * (when present) against related active facts. No DB writes happen here.
   */
  private async planExtractedFacts(
    scopeId: string,
    scopeKey: string,
    observedAt: string,
    extracted: ExtractedFact[],
  ): Promise<ExtractedFactPlan[]> {
    const plans: ExtractedFactPlan[] = []
    for (const fact of extracted) {
      const composed = this.composeStatement(scopeKey, fact)
      if (!composed) {
        continue
      }
      // 1) Exact statement_hash within scope (plan §13.5 exact tier).
      const existingActive = this.store.facts.getActiveByStatementHash(
        scopeId,
        composed.statementHash,
      )
      if (existingActive) {
        plans.push({
          ...composed,
          extracted: fact,
          decision: {
            kind: 'duplicate',
            targetFactId: existingActive.id,
            reason: 'exact statement_hash',
          },
        })
        continue
      }
      const replacement = this.findActiveReplacement(scopeId, composed.statementHash)
      if (replacement) {
        plans.push({
          ...composed,
          extracted: fact,
          decision: {
            kind: 'duplicate',
            targetFactId: replacement.id,
            reason: 'exact statement_hash (superseded chain)',
          },
        })
        continue
      }

      // 2) Semantic tier (plan §13.5/§13.6): reconcile against related active facts.
      const decision = await this.reconcileCandidate(scopeId, fact, composed.entityNames)
      plans.push({ ...composed, extracted: fact, decision })
    }
    return plans
  }

  /**
   * Apply pre-computed {@link ExtractedFactPlan}s inside a single transaction:
   * attach evidence for duplicates; insert + supersede for supersessions; insert
   * fresh active facts for new. Returns the created/targeted facts in order,
   * de-duplicated by id (a duplicate target may recur). Within this run we also
   * short-circuit a second candidate that re-hashes to a fact we just inserted.
   */
  private commitExtractedFacts(
    scopeId: string,
    scopeKey: string,
    episode: Episode,
    observedAt: string,
    extractorName: string,
    plans: ExtractedFactPlan[],
  ): Fact[] {
    const touched: Fact[] = []
    const seen = new Set<string>()
    const push = (fact: Fact): void => {
      if (!seen.has(fact.id)) {
        seen.add(fact.id)
        touched.push(fact)
      }
    }

    for (const plan of plans) {
      const span = this.evidenceSpan(plan.extracted)
      // Defense-in-depth (plan §18.1): re-redact the provider-supplied quote
      // before persistence, mirroring composeStatement's per-field redaction. A
      // buggy/adversarial remote model could return a quote that is not a slice
      // of the redacted input (e.g. an echoed secret); never store it verbatim.
      const quote = redact(plan.extracted.evidence?.quote ?? plan.statement).redacted

      if (plan.decision.kind === 'duplicate') {
        const target = this.store.facts.getById(plan.decision.targetFactId)
        if (target) {
          this.attachEvidence(target.id, episode, span, quote, extractorName, LLM_EXTRACTOR_VERSION)
          push(target)
          continue
        }
        // Target vanished mid-run — fall through to insert as new.
      }

      // Re-check exact hash inside the txn: an earlier candidate THIS run may
      // have already inserted the same statement as active (a single capture can
      // emit two semantically identical candidates). The partial unique index
      // `idx_facts_active_hash` forbids a second active row per (scope, hash), so
      // we honor the existing active row regardless of decision kind — inserting
      // again would throw and abort the whole capture (plan §13.3 "never fails").
      const existingActive = this.store.facts.getActiveByStatementHash(scopeId, plan.statementHash)
      if (existingActive) {
        this.attachEvidence(
          existingActive.id,
          episode,
          span,
          quote,
          extractorName,
          LLM_EXTRACTOR_VERSION,
        )
        // A `supersedes` candidate whose own statement already materialized as
        // active still carries a supersession judgement against its target; do
        // not lose it — record it against the existing active row (re-resolving
        // a target that was itself superseded earlier this batch, §13.6).
        if (plan.decision.kind === 'supersedes') {
          this.applySupersession(
            plan.decision.targetFactId,
            existingActive.id,
            plan.decision.reason,
          )
        }
        push(existingActive)
        continue
      }

      const entities = linkEntities(this.store, scopeId, extractEntities(plan.statement))
      const subjectEntity = plan.subject ? this.findEntityByName(entities, plan.subject) : undefined
      const objectEntity = plan.objectValue
        ? this.findEntityByName(entities, plan.objectValue)
        : undefined
      const fact = this.insertFact({
        scopeId,
        subjectEntityId: subjectEntity?.id ?? null,
        predicate: plan.predicate,
        objectEntityId: objectEntity?.id ?? null,
        objectValue: objectEntity ? null : plan.objectValue || null,
        statement: plan.statement,
        statementHash: plan.statementHash,
        confidence: clamp01(plan.extracted.confidence),
        observedAt,
        validFrom: plan.extracted.valid_from,
        validTo: plan.extracted.valid_to,
      })
      this.attachEvidence(fact.id, episode, span, quote, extractorName, LLM_EXTRACTOR_VERSION)
      this.store.facts.indexFact(
        fact,
        scopeKey,
        this.buildEntityText(entities, plan.objectValue || null),
      )

      if (plan.decision.kind === 'supersedes') {
        this.applySupersession(plan.decision.targetFactId, fact.id, plan.decision.reason)
      }
      push(fact)
    }
    return touched
  }

  /**
   * Record a supersession of `targetFactId` by `newFactId` within a commit
   * (plan §13.6). Reconcile decisions are planned against a pre-write snapshot,
   * so an earlier candidate in the SAME batch may already have superseded the
   * planned target. If so, re-resolve to the surviving active head at the end of
   * the target's supersession chain and supersede THAT, so multiple candidates
   * touching one attribute form a single chain (F0 -> F1 -> F2) instead of
   * leaving conflicting active facts with a dropped link. No-op when the
   * resolved target is the new fact itself or no active target survives.
   */
  private applySupersession(targetFactId: string, newFactId: string, reason?: string): void {
    let target = this.store.facts.getById(targetFactId)
    if (target && target.status !== 'active') {
      const terminalId = this.findChainTerminus(targetFactId)
      target = terminalId ? this.store.facts.getById(terminalId) : undefined
    }
    if (!target || target.status !== 'active' || target.id === newFactId) {
      return
    }
    this.store.facts.updateStatus(target.id, 'superseded')
    this.store.supersessions.insert({
      id: newSupersessionId(),
      oldFactId: target.id,
      newFactId,
      reason: reason ?? null,
      confidence: null,
      createdAt: nowIso(),
    })
  }

  /**
   * Compose the canonical (subject, predicate, object) triple, the human
   * statement, and the portable `statement_hash` for an extracted candidate.
   * Defense-in-depth: re-redact each field even though the input was redacted
   * (plan §18.1). Returns `null` when the candidate has no usable statement.
   */
  private composeStatement(
    scopeKey: string,
    fact: ExtractedFact,
  ): {
    subject: string
    predicate: string
    objectValue: string
    statement: string
    statementHash: string
    entityNames: string[]
  } | null {
    const subject = redact(fact.subject ?? '').redacted.trim()
    const predicate = redact(fact.predicate ?? '').redacted.trim() || DEFAULT_PREDICATE
    const objectValue = redact(fact.object ?? '').redacted.trim()
    const rawStatement = redact(fact.statement ?? '').redacted.trim()
    const statement =
      rawStatement || [subject, predicate, objectValue].filter((p) => p.length > 0).join(' ')
    if (statement.length === 0) {
      return null
    }
    const hash = statementHash({
      scopeKey,
      subject: subject || null,
      predicate,
      object: objectValue || statement,
    })
    const entityNames = (fact.entities ?? [])
      .map((e) => redact(e).redacted.trim())
      .filter((e) => e.length > 0)
    return { subject, predicate, objectValue, statement, statementHash: hash, entityNames }
  }

  /**
   * Semantic reconcile (plan §13.5/§13.6). Gathers related ACTIVE facts within
   * scope (by linked entities + FTS over the statement) and, when the provider
   * exposes `reconcile`, asks it to judge the candidate. Returns the typed
   * decision. With no related facts or no `reconcile`, the candidate is `new`
   * (auto-supersession never fires below the LLM tier, plan §13.5 tiers).
   */
  private async reconcileCandidate(
    scopeId: string,
    candidate: ExtractedFact,
    entityNames: string[],
  ): Promise<ExtractedFactPlan['decision']> {
    if (!this.extractor?.reconcile) {
      return { kind: 'new' }
    }
    const related = this.relatedActiveFacts(scopeId, candidate, entityNames)
    if (related.length === 0) {
      return { kind: 'new' }
    }
    let decision: ReconcileDecision
    try {
      decision = await this.extractor.reconcile({
        candidate,
        related: related.map((f) => ({ id: f.id, statement: f.statement })),
      })
    } catch {
      // Reconcile failure is non-fatal: treat the candidate as additive.
      return { kind: 'new' }
    }
    if (
      (decision.kind === 'duplicate' || decision.kind === 'supersedes') &&
      decision.targetFactId
    ) {
      // Only honor a target that is actually in the related set (plan §18.3:
      // never act on a fact outside the in-scope candidate set).
      if (related.some((f) => f.id === decision.targetFactId)) {
        return { kind: decision.kind, targetFactId: decision.targetFactId, reason: decision.reason }
      }
    }
    return { kind: 'new' }
  }

  /**
   * Related ACTIVE facts for a candidate within `scopeId`: union of facts whose
   * linked entities match the candidate's entity names and facts matching its
   * statement text via FTS, restricted to `status = 'active'`. Bounded for the
   * reconcile prompt (plan §13.5).
   */
  private relatedActiveFacts(
    scopeId: string,
    candidate: ExtractedFact,
    entityNames: string[],
  ): Fact[] {
    const byId = new Map<string, Fact>()
    const allowed = new Set([scopeId])

    const normalizedKeys = entityNames
      .map((n) => normalizeEntityName(n))
      .filter((k) => k.length >= 2)
    for (const fact of this.factsByEntityNames(normalizedKeys, allowed)) {
      if (fact.status === 'active') {
        byId.set(fact.id, fact)
      }
    }

    const scopeKey = this.store.scopes.getById(scopeId)?.key
    if (scopeKey) {
      const ftsQuery = buildFtsMatch(candidate.statement ?? '')
      if (ftsQuery) {
        for (const hit of this.store.facts.ftsSearch(
          [scopeKey],
          ftsQuery,
          RECONCILE_RELATED_LIMIT,
        )) {
          if (hit.fact.scopeId === scopeId && hit.fact.status === 'active') {
            byId.set(hit.fact.id, hit.fact)
          }
        }
      }
    }

    return [...byId.values()].slice(0, RECONCILE_RELATED_LIMIT)
  }

  /** Insert a fact with `status = 'active'` and now-stamped timestamps. */
  private insertFact(input: {
    scopeId: string
    subjectEntityId: string | null
    predicate: string
    objectEntityId: string | null
    objectValue: string | null
    statement: string
    statementHash: string
    confidence: number
    observedAt: string
    validFrom: string | null
    validTo: string | null
  }): Fact {
    const now = nowIso()
    const fact: Fact = {
      id: newFactId(),
      scopeId: input.scopeId,
      subjectEntityId: input.subjectEntityId,
      predicate: input.predicate,
      objectEntityId: input.objectEntityId,
      objectValue: input.objectValue,
      statement: input.statement,
      statementHash: input.statementHash,
      confidence: input.confidence,
      status: 'active',
      validFrom: input.validFrom,
      validTo: input.validTo,
      observedAt: input.observedAt,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    }
    this.store.facts.insert(fact)
    return fact
  }

  /**
   * Insert an evidence row linking a fact to its source episode (plan §11.6),
   * honoring the retention mode (plan §10.1) for the persisted quote text:
   *
   * - `redacted`/`encrypted`: store the redacted quote + its `quote_hash`.
   * - `minimal`: store NO quote TEXT (`redacted_quote = null`) — facts and
   *   evidence HASHES only — but keep the `quote_hash` (computed in memory).
   * - `none`: store NO quote text AND no `quote_hash` (extracted facts only).
   *
   * The same retention gate `EpisodeService.capture` applies to the episode body
   * is applied here so the EXTRACTOR commit path cannot persist evidence text the
   * retention mode promised was never stored (e.g. a later `naru backup` raw copy
   * would otherwise exfiltrate it). The `quote` argument is still used to compute
   * the hash before being discarded, so provenance survives under `minimal`.
   */
  private attachEvidence(
    factId: string,
    episode: Episode,
    span: { start: number; end: number } | null,
    quote: string,
    extractorName: string,
    extractorVersion: string,
  ): void {
    const stripText = this.defaultRetention === 'minimal' || this.defaultRetention === 'none'
    const evidence: Evidence = {
      id: newEvidenceId(),
      factId,
      episodeId: episode.id,
      spanStart: span?.start ?? null,
      spanEnd: span?.end ?? null,
      redactedQuote: stripText ? null : quote,
      // `minimal` keeps the hash (facts + evidence HASHES only); `none` keeps
      // neither text nor hash (extracted facts only) — plan §10.1.
      quoteHash: this.defaultRetention === 'none' ? null : sha256Hex(quote),
      extractorName,
      extractorVersion,
      createdAt: nowIso(),
    }
    this.store.evidence.insert(evidence)
  }

  /** Validated, non-negative evidence span from an extracted candidate, or null. */
  private evidenceSpan(fact: ExtractedFact): { start: number; end: number } | null {
    const ev = fact.evidence
    if (!ev) {
      return null
    }
    const { span_start: start, span_end: end } = ev
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    ) {
      return null
    }
    return { start, end }
  }

  /**
   * Embed the query text and return its vector, or `undefined` when no embedder
   * is configured, the query has no usable text, the embedded vector carries no
   * signal, or the embed call fails (so the caller degrades to lexical/entity
   * retrieval, plan §6.2). The query is redacted before embedding (plan §18.1)
   * since the embedder may be remote.
   *
   * A query whose tokens all drop out (punctuation/symbol- or stopword-only)
   * embeds to a zero-magnitude vector: it has no direction, so cosine scores
   * every fact at 0 and would surface the entire in-scope corpus. Such a vector
   * is treated as "no vector signal" (return `undefined`) so hybrid search
   * matches lexical search's empty result for the same input.
   */
  private async embedQuery(query: string): Promise<Float32Array | undefined> {
    if (!this.embedder) {
      return undefined
    }
    const text = redact(query).redacted.trim()
    if (text.length === 0) {
      return undefined
    }
    try {
      const [vec] = await this.embedder.embed([text])
      if (!vec || !hasSignal(vec)) {
        return undefined
      }
      return vec
    } catch {
      return undefined
    }
  }

  /**
   * Embed each fact's (already-redacted) statement and upsert its vector (plan
   * §11.9, §12.2). No-op when no embedder is configured or `facts` is empty.
   * Batched into one `embed` call. Embedding failure is swallowed: vectors are a
   * rebuildable derived index, so a transient embed error must not fail the
   * surrounding write (capture stays resilient, plan §13.3/§6.2).
   */
  private async embedAndStore(facts: Fact[]): Promise<void> {
    if (!this.embedder || facts.length === 0) {
      return
    }
    const embedder = this.embedder
    const texts = facts.map((f) => f.statement)
    let vectors: Float32Array[]
    try {
      vectors = await embedder.embed(texts)
    } catch {
      return
    }
    if (vectors.length !== facts.length) {
      return
    }
    this.store.transaction(() => {
      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i]
        const vector = vectors[i]
        if (!fact || !vector) {
          continue
        }
        this.store.vectors.upsertVector(fact.id, {
          provider: embedder.name,
          model: embedder.model,
          dimension: embedder.dimension,
          vector,
          sourceHash: sha256Hex(fact.statement),
        })
      }
    })
  }

  private toResultItem(
    fact: Fact,
    reasons: string[],
    score: number,
    scopeKeyById: Map<string, string>,
  ): SearchResultItem {
    return {
      factId: fact.id,
      statement: fact.statement,
      scope: scopeKeyById.get(fact.scopeId) ?? fact.scopeId,
      score,
      reasons,
      temporal: { validFrom: fact.validFrom, validTo: fact.validTo },
      evidenceRefs: this.store.evidence.listByFact(fact.id).map((e) => e.id),
    }
  }

  private buildEntityText(entities: Entity[], objectValue: string | null): string {
    const parts = entities.map((e) => e.canonicalName)
    if (objectValue) {
      parts.push(objectValue)
    }
    return parts.filter((p) => p.length > 0).join(' ')
  }

  private findEntityByName(entities: Entity[], name: string): Entity | undefined {
    const key = normalizeEntityName(name)
    return entities.find((e) => e.normalizedKey === key)
  }

  /** Facts referencing any entity whose normalized key matches, within scopes. */
  private factsByEntityNames(normalizedKeys: string[], allowedScopeIds: Set<string>): Fact[] {
    if (normalizedKeys.length === 0 || allowedScopeIds.size === 0) {
      return []
    }
    const keyPlaceholders = normalizedKeys.map(() => '?').join(', ')
    const scopeIds = [...allowedScopeIds]
    const scopePlaceholders = scopeIds.map(() => '?').join(', ')
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT f.id AS id
           FROM facts f
           JOIN entities e
             ON e.id = f.subject_entity_id OR e.id = f.object_entity_id
          WHERE e.normalized_key IN (${keyPlaceholders})
            AND f.scope_id IN (${scopePlaceholders})`,
      )
      .all(...normalizedKeys, ...scopeIds) as { id: string }[]
    const facts: Fact[] = []
    for (const row of rows) {
      const fact = this.store.facts.getById(row.id)
      if (fact) {
        facts.push(fact)
      }
    }
    return facts
  }

  /** Old-fact IDs that have an active replacement (excluded from current view). */
  private supersededOldFactIds(): Set<string> {
    const rows = this.store.db
      .prepare(
        `SELECT sup.old_fact_id AS old_id
           FROM supersessions sup
           JOIN facts nf ON nf.id = sup.new_fact_id
          WHERE nf.status = 'active'`,
      )
      .all() as { old_id: string }[]
    return new Set(rows.map((r) => r.old_id))
  }

  private entityHasFacts(entityId: string): boolean {
    const row = this.store.db
      .prepare(
        'SELECT 1 AS hit FROM facts WHERE subject_entity_id = ? OR object_entity_id = ? LIMIT 1',
      )
      .get(entityId, entityId) as { hit: number } | undefined
    return row !== undefined
  }

  /**
   * Given a `(scope, statement_hash)` with no active row but a superseded one,
   * resolve the active replacement at the end of its supersession chain (plan
   * §13.6). Walks forward from each superseded fact sharing the hash; returns
   * the first terminal fact that is still `active`, or undefined if the chain
   * has no surviving active replacement (e.g. it was forgotten).
   */
  private findActiveReplacement(scopeId: string, hash: string): Fact | undefined {
    const candidates = this.store.facts.listByStatementHash(scopeId, hash)
    for (const candidate of candidates) {
      if (candidate.status !== 'superseded') {
        continue
      }
      const terminalId = this.findChainTerminus(candidate.id)
      if (!terminalId) {
        continue
      }
      const terminal = this.store.facts.getById(terminalId)
      if (terminal && terminal.status === 'active') {
        return terminal
      }
    }
    return undefined
  }

  /** Walk a supersession chain forward from `factId` to its terminal fact. */
  private findChainTerminus(factId: string): string | null {
    const visited = new Set<string>()
    let currentId: string | null = factId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const forward = this.store.supersessions.listByOld(currentId)
      const next = forward[0]?.newFactId
      if (!next) {
        return currentId
      }
      currentId = next
    }
    return currentId
  }

  private findChainRoot(factId: string): string | null {
    const visited = new Set<string>()
    let currentId: string | null = factId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const backward = this.store.supersessions.listByNew(currentId)
      const prev = backward[0]?.oldFactId
      if (!prev) {
        return currentId
      }
      currentId = prev
    }
    return currentId
  }

  private resolveForgetFactIds(selector: ForgetSelector): string[] {
    if (selector.factId) {
      return [selector.factId]
    }

    const ids = new Set<string>()

    if (selector.entityId) {
      const rows = this.store.db
        .prepare('SELECT id FROM facts WHERE subject_entity_id = ? OR object_entity_id = ?')
        .all(selector.entityId, selector.entityId) as { id: string }[]
      for (const r of rows) {
        ids.add(r.id)
      }
    }

    if (selector.episodeId) {
      const rows = this.store.db
        .prepare('SELECT DISTINCT fact_id FROM evidence WHERE episode_id = ?')
        .all(selector.episodeId) as { fact_id: string }[]
      for (const r of rows) {
        ids.add(r.fact_id)
      }
    }

    if (selector.scope || selector.before || selector.after) {
      const clauses: string[] = []
      const params: unknown[] = []
      if (selector.scope) {
        const scope = this.store.scopes.getByKey(`${selector.scope.type}:${selector.scope.key}`)
        if (!scope) {
          return [...ids]
        }
        clauses.push('scope_id = ?')
        params.push(scope.id)
      }
      if (selector.before) {
        clauses.push('observed_at < ?')
        params.push(selector.before)
      }
      if (selector.after) {
        clauses.push('observed_at > ?')
        params.push(selector.after)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = this.store.db.prepare(`SELECT id FROM facts ${where}`).all(...params) as {
        id: string
      }[]
      for (const r of rows) {
        ids.add(r.id)
      }
    }

    return [...ids]
  }
}

// --- ranking helpers ----------------------------------------------------

/**
 * Divisor that maps a raw {@link SCOPE_RANK} weight (max 6 = `session`) into
 * [0,1] so the scope signal is comparable with the other normalized signals.
 */
const SCOPE_RANK_DIVISOR = 6

/** Clamp a value into [0, 1]. */
function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * Whether a vector carries any direction (non-zero magnitude). A zero vector has
 * no direction, so cosine treats it as similar to nothing; treating it as "no
 * signal" keeps a token-less query from surfacing the whole in-scope corpus.
 */
function hasSignal(vec: Float32Array): boolean {
  for (let i = 0; i < vec.length; i++) {
    if ((vec[i] ?? 0) !== 0) {
      return true
    }
  }
  return false
}

/**
 * Normalize a SQLite bm25 score (lower/more-negative = more relevant) into
 * [0, 1] where 1 is best, using min-max over the candidate set (plan §14.2).
 * A candidate with no bm25 score (entity-only match) gets a neutral 0.5.
 */
function normalizeBm25(value: number | undefined, all: number[]): number {
  if (value === undefined || all.length === 0) {
    return 0.5
  }
  const min = Math.min(...all)
  const max = Math.max(...all)
  if (min === max) {
    return 1
  }
  // bm25 is more relevant when smaller; invert so smaller -> closer to 1.
  return clamp01(1 - (value - min) / (max - min))
}

/**
 * Normalize a cosine similarity (higher = more similar) into [0,1] using min-max
 * over the candidate set (plan §14.2 — bm25 and cosine are not on one scale, so
 * each is normalized independently before the weighted-linear combine). A
 * candidate with no cosine score (lexical/entity-only hit) gets a neutral 0 so a
 * fact the vector index never surfaced contributes nothing to the cosine term
 * rather than a misleading mid score. When every candidate shares one cosine
 * value, they all map to 1 (the signal carries no ordering information).
 */
function normalizeCosine(value: number | undefined, all: number[]): number {
  if (value === undefined) {
    return 0
  }
  if (all.length === 0) {
    return 0
  }
  const min = Math.min(...all)
  const max = Math.max(...all)
  if (min === max) {
    return 1
  }
  return clamp01((value - min) / (max - min))
}

/**
 * Entity-match strength in [0,1] (plan §14.2): the share of query entities this
 * fact matched. We do not track per-entity overlap counts in the candidate, so
 * this is binary — 1 when the fact was pulled in by the entity source, else 0 —
 * which is a faithful "did the query's entities hit this fact" signal. 0 when
 * the query carried no entities (the signal is inapplicable, not penalizing).
 */
function entityMatchScore(candidate: Candidate, queryEntityCount: number): number {
  if (queryEntityCount === 0) {
    return 0
  }
  return candidate.reasons.has('entity') ? 1 : 0
}

/** Recency score in [0, 1]: ~1 today, decaying over ~365 days (plan §14.2). */
function recencyScore(observedAt: string): number {
  const t = Date.parse(observedAt)
  if (Number.isNaN(t)) {
    return 0
  }
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24)
  if (ageDays <= 0) {
    return 1
  }
  return clamp01(1 - ageDays / 365)
}

/**
 * Build a safe FTS5 MATCH query from free text (plan §14.1). FTS5 treats many
 * characters as operators, so we tokenize to word/number runs and OR the
 * double-quoted tokens together. Returns null when no usable token remains.
 */
function buildFtsMatch(query: string): string | null {
  const tokens = query
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
  if (!tokens || tokens.length === 0) {
    return null
  }
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

// --- context packing (plan §14.4) ---------------------------------------

/** Rough token estimate: ~4 chars per token (plan §14.4 `token_estimate`). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** One bullet line for a packed item; the prompt block joins these with `\n`. */
function renderItemLine(item: SearchResultItem): string {
  return `- ${item.statement} (scope: ${item.scope})`
}

/**
 * Greedily pack ranked search hits into a token-bounded prompt block (plan
 * §14.4). Items are consumed in rank order; an item is included only if adding
 * its rendered line keeps the running `tokenEstimate` AT OR BELOW `budget`. The
 * returned `tokenEstimate` is computed from the final `promptBlock` and NEVER
 * exceeds the budget. Each included item carries its per-signal `reason` for
 * inspectability. An empty hit list yields an empty block and 0 tokens.
 */
function packContext(hits: SearchResultItem[], budget: number): BuildContextResult {
  const HEADER = 'Relevant memory:'
  const items: ContextItem[] = []
  const lines: string[] = []
  // Account for the header up front so a budget can't be blown by the prefix.
  let block = hits.length > 0 ? HEADER : ''

  for (const hit of hits) {
    const line = renderItemLine(hit)
    const candidateBlock = [block, line].filter((s) => s.length > 0).join('\n')
    if (estimateTokens(candidateBlock) > budget) {
      // Stop at the first item that would exceed the budget. Items are already
      // rank-ordered, so this preserves the most relevant fit (plan §14.4).
      break
    }
    block = candidateBlock
    lines.push(line)
    items.push({
      factId: hit.factId,
      statement: hit.statement,
      scope: hit.scope,
      score: hit.score,
      evidenceRefs: hit.evidenceRefs,
      temporal: hit.temporal,
      reason: hit.reasons,
    })
  }

  // If nothing fit (header alone over budget, or every first line too large),
  // the block is empty rather than an orphan header.
  if (items.length === 0) {
    return { items: [], promptBlock: '', tokenEstimate: 0 }
  }
  const promptBlock = [HEADER, ...lines].join('\n')
  return { items, promptBlock, tokenEstimate: estimateTokens(promptBlock) }
}
