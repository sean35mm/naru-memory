import { readFileSync, writeFileSync } from 'node:fs'
import {
  type Edge,
  type Entity,
  type Episode,
  type Evidence,
  type Fact,
  HASH_VERSION,
  type RetentionMode,
  type Scope,
  type Supersession,
  newEdgeId,
  newEntityId,
  newEpisodeId,
  newEvidenceId,
  newFactId,
  newScopeId,
  newSupersessionId,
  nowIso,
} from '@naru/schema'
import { type Store, knownSchemaVersions, latestSchemaVersion } from '@naru/store-sqlite'

/**
 * Embedding provenance recorded in a bundle (plan §19): the provider/model/
 * dimension whose vectors were dropped at export. Lets the importer warn that
 * re-embedding needs this exact provider/model (or a chosen replacement) and
 * incurs compute cost (plan §12.2 vector-rebuild caveat).
 */
export interface BundleEmbedding {
  provider: string
  model: string
  dimension: number
}

/**
 * A portable memory bundle (plan §19): the CANONICAL tables only — scopes,
 * episodes, entities, facts, evidence, edges, supersessions — plus the metadata
 * an importer needs to validate and rebuild.
 *
 * NOT included (plan §12.2 derived/rebuildable): FTS rows, vector rows, and the
 * `index_state`/`embeddings` bookkeeping tables. Import rebuilds those from the
 * canonical rows (FTS always; vectors only when an embedder is configured).
 *
 * Retention honoring (plan §10.1/§19): under `minimal`/`none` retention the
 * source text is not retained, so the exporter OMITS episode `redactedText` and
 * evidence `redactedQuote` (their hashes/ids/structure are still carried). Such
 * a bundle's facts cannot be re-extracted and its vectors cannot be regenerated
 * from canonical data — the §10.1 rebuildability trade is surfaced on import.
 */
export interface MemoryBundle {
  /**
   * Canonical schema version the bundle was produced at (the exporter store's
   * latest migration version). Validated on import against the versions this
   * build knows; an unknown version is rejected (plan §19 validate-schema).
   */
  schemaVersion: string
  /** Hash-canonicalization version (plan §11.5). Validated on import. */
  hashVersion: number
  exportedAt: string
  /** Retention mode the exporting store was opened with (plan §10.1). */
  retentionMode: RetentionMode
  /**
   * Embedding provenance at export time, when an embedder was configured. Carries
   * the provider/model/dimension so the importer can warn about re-embedding
   * (plan §12.2/§19). Absent when the exporter had no embedder.
   */
  embedding?: BundleEmbedding
  scopes: Scope[]
  episodes: Episode[]
  entities: Entity[]
  facts: Fact[]
  evidence: Evidence[]
  edges: Edge[]
  supersessions: Supersession[]
}

/** Options for {@link exportBundle}. */
export interface ExportBundleOptions {
  /** Embedding provenance to stamp into the bundle (plan §19). */
  embedding?: BundleEmbedding
}

/**
 * Build a portable bundle from a store's CANONICAL rows (plan §19).
 *
 * Reads every canonical table; never reads or emits derived indexes (FTS/vector/
 * `index_state`). Under `minimal`/`none` retention the episode `redactedText`
 * and evidence `redactedQuote` are stripped to `null` so no source text leaves
 * the store (plan §10.1) — the rest of the row (ids, hashes, spans, structure)
 * is preserved so references and dedupe survive a round-trip.
 *
 * The store does not itself know its retention mode, so the caller passes it
 * (the {@link Naru} facade supplies its configured mode). `embedding` provenance
 * is likewise supplied by the caller from its configured embedder.
 */
export function exportBundle(
  store: Store,
  retentionMode: RetentionMode,
  options: ExportBundleOptions = {},
): MemoryBundle {
  const stripText = retentionMode === 'minimal' || retentionMode === 'none'

  const episodes = store.episodes
    .listAll()
    .map((ep) => (stripText ? { ...ep, redactedText: null } : ep))
  const evidence = store.evidence
    .listAll()
    .map((ev) => (stripText ? { ...ev, redactedQuote: null } : ev))

  const bundle: MemoryBundle = {
    schemaVersion: latestSchemaVersion(),
    hashVersion: HASH_VERSION,
    exportedAt: nowIso(),
    retentionMode,
    scopes: store.scopes.list(),
    episodes,
    entities: store.entities.listAll(),
    facts: store.facts.listAll(),
    evidence,
    edges: store.edges.listAll(),
    supersessions: store.supersessions.listAll(),
  }
  if (options.embedding) {
    bundle.embedding = options.embedding
  }
  return bundle
}

/** Serialize a bundle to a JSON file (plan §19 writeBundle). */
export function writeBundle(
  store: Store,
  retentionMode: RetentionMode,
  filePath: string,
  options: ExportBundleOptions = {},
): MemoryBundle {
  const bundle = exportBundle(store, retentionMode, options)
  writeFileSync(filePath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 })
  return bundle
}

/** Per-table counts of rows actually inserted by an import. */
export interface ImportCounts {
  scopes: number
  episodes: number
  entities: number
  facts: number
  evidence: number
  edges: number
  supersessions: number
}

/**
 * Outcome of {@link importBundle} (plan §19). `skippedDuplicates` counts rows
 * that matched an existing portable identity (scope key, episode source_hash,
 * entity key, fact statement_hash, …) and were not re-inserted. `remappedIds`
 * counts ids that collided with DIFFERENT existing content and were minted
 * anew (references fixed up). `skippedConflicts` counts bundle rows that could
 * NOT be inserted without violating a destination uniqueness invariant and were
 * dropped rather than aborting the whole import (e.g. a tampered/hand-edited
 * bundle whose active fact collides on `(scope, statement_hash)` with different
 * destination content). Exactly one of `vectorsRebuilt`/`reembedNeeded`
 * describes the vector outcome.
 */
export interface ImportResult {
  imported: ImportCounts
  skippedDuplicates: number
  remappedIds: number
  /**
   * Bundle rows dropped to preserve a destination uniqueness invariant (e.g. the
   * active-hash unique index) instead of aborting the transaction. 0 in the
   * normal case; non-zero only for adversarial/divergent bundles.
   */
  skippedConflicts: number
  /** Set when an embedder was configured and vectors were rebuilt from facts. */
  vectorsRebuilt?: { embedded: number }
  /**
   * Set when an embedder IS configured but its provider/model/dimension differ
   * from the bundle's recorded embedding provenance (plan §19 mismatch warning).
   * The facts were re-embedded under the LIVE embedder (`reembeddedUnder`), which
   * is a DIFFERENT semantic space than the bundle was exported in (`bundleEmbedding`).
   */
  embeddingMismatch?: {
    reembeddedUnder: BundleEmbedding
    bundleEmbedding: BundleEmbedding
  }
  /**
   * Set when NO embedder was configured (or the bundle's facts have no source to
   * re-embed): vectors are left empty and a re-embed is needed. Carries the
   * bundle's embedding provenance so the operator knows which provider/model to
   * make available (plan §12.2/§19).
   */
  reembedNeeded?: { reason: string; embedding?: BundleEmbedding }
}

/** Hooks the importer needs from the runtime (supplied by {@link Naru}). */
export interface ImportDeps {
  /**
   * Rebuild the vector index from canonical facts when an embedder is
   * configured, returning the embedded count; resolves to `null` when no
   * embedder is configured (vectors left empty -> re-embed needed). Always
   * rebuilds FTS regardless (the caller wires it to the reindex path).
   */
  rebuildVectors(): Promise<{ embedded: number } | null>
  /**
   * The LIVE embedder's provenance, supplied by the facade (which owns the
   * configured embedder). When present alongside `bundle.embedding` and the two
   * differ, the importer reports an {@link ImportResult.embeddingMismatch} so the
   * operator knows the facts were re-embedded into a different semantic space
   * than the bundle was exported in (plan §19 mismatch warning). `undefined`
   * when no embedder is configured.
   */
  liveEmbedding?: BundleEmbedding
}

/**
 * Validate a parsed bundle's shape + versions (plan §19). Throws on an unknown
 * `schemaVersion` (e.g. a newer Naru's migrations) or a `hashVersion` mismatch
 * so a bundle is never silently mis-imported under the wrong canonicalization.
 */
function validateBundle(bundle: MemoryBundle): void {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('invalid bundle: not an object')
  }
  const known = knownSchemaVersions()
  if (!known.includes(bundle.schemaVersion)) {
    throw new Error(
      `unsupported bundle schemaVersion "${bundle.schemaVersion}": this build knows ${known.join(', ')}. Upgrade Naru to import a bundle from a newer schema.`,
    )
  }
  if (bundle.hashVersion !== HASH_VERSION) {
    throw new Error(
      `unsupported bundle hashVersion ${bundle.hashVersion}: this build uses hashVersion ${HASH_VERSION}. Portable hashes would not line up; re-export from a matching Naru.`,
    )
  }
  for (const key of [
    'scopes',
    'episodes',
    'entities',
    'facts',
    'evidence',
    'edges',
    'supersessions',
  ] as const) {
    if (!Array.isArray(bundle[key])) {
      throw new Error(`invalid bundle: "${key}" must be an array`)
    }
  }
}

/** Read + parse a bundle file from disk. */
export function readBundleFile(filePath: string): MemoryBundle {
  return JSON.parse(readFileSync(filePath, 'utf8')) as MemoryBundle
}

/**
 * Import a portable bundle into a store (plan §19).
 *
 * Validates the schema/hash version, then inserts the canonical rows inside ONE
 * transaction in dependency order (scopes -> episodes/entities -> facts ->
 * evidence -> edges -> supersessions). Dedupe is by PORTABLE identity, not raw
 * id: scopes by `key`, episodes by `(scope, source_hash)`, entities by
 * `(scope, normalized_key, type)`, facts by `(scope, statement_hash)` matching
 * status + statement. A matched row is skipped and its bundle id is remapped to
 * the existing row's id so references resolve. When a bundle id does NOT match
 * an existing portable identity but its raw id is already taken by DIFFERENT
 * content, a fresh id is minted and every reference (evidence.fact_id/episode_id,
 * edges, supersessions, entity links on facts) is rewritten to it.
 *
 * After the canonical load, derived indexes are rebuilt (plan §12.2): FTS always
 * (via the caller's reindex wiring inside {@link ImportDeps.rebuildVectors} path
 * — the facade rebuilds FTS first), vectors only when an embedder is configured.
 * With no embedder, vectors stay empty and the result reports `reembedNeeded`
 * carrying the bundle's embedding provenance.
 */
export async function importBundle(
  store: Store,
  bundle: MemoryBundle,
  deps: ImportDeps,
): Promise<ImportResult> {
  validateBundle(bundle)

  const imported: ImportCounts = {
    scopes: 0,
    episodes: 0,
    entities: 0,
    facts: 0,
    evidence: 0,
    edges: 0,
    supersessions: 0,
  }
  let skippedDuplicates = 0
  let remappedIds = 0
  let skippedConflicts = 0

  // bundle id -> resolved (possibly remapped) store id, per table.
  const scopeIdMap = new Map<string, string>()
  const episodeIdMap = new Map<string, string>()
  const entityIdMap = new Map<string, string>()
  const factIdMap = new Map<string, string>()

  store.transaction(() => {
    // --- scopes (dedupe by key) -----------------------------------------
    // `idTaken` tracks ids already present in the store OR minted this run, so a
    // preserved id never collides with a different row's id (plan §19).
    const scopeIdTaken = new Set(store.scopes.list().map((s) => s.id))
    for (const scope of bundle.scopes) {
      const existing = store.scopes.getByKey(scope.key)
      if (existing) {
        scopeIdMap.set(scope.id, existing.id)
        skippedDuplicates++
        continue
      }
      let id = scope.id
      if (scopeIdTaken.has(id)) {
        id = newScopeId()
        remappedIds++
      }
      // Remap parent through any already-resolved scope (parents sort earlier by
      // created_at, so a mapped parent is present); fall back to the raw id.
      const parentScopeId =
        scope.parentScopeId === null
          ? null
          : (scopeIdMap.get(scope.parentScopeId) ?? scope.parentScopeId)
      store.scopes.insertRaw({ ...scope, id, parentScopeId })
      scopeIdTaken.add(id)
      scopeIdMap.set(scope.id, id)
      imported.scopes++
    }

    // --- entities (dedupe by (scope, normalized_key, type)) -------------
    const entityIdTaken = new Set(store.entities.listAll().map((e) => e.id))
    for (const entity of bundle.entities) {
      const resolvedScopeId =
        entity.scopeId === null ? null : (scopeIdMap.get(entity.scopeId) ?? entity.scopeId)
      const existing = store.entities.findByKey(resolvedScopeId, entity.normalizedKey, entity.type)
      if (existing) {
        entityIdMap.set(entity.id, existing.id)
        skippedDuplicates++
        continue
      }
      let id = entity.id
      if (entityIdTaken.has(id)) {
        id = newEntityId()
        remappedIds++
      }
      store.entities.insertRaw({ ...entity, id, scopeId: resolvedScopeId })
      entityIdTaken.add(id)
      entityIdMap.set(entity.id, id)
      imported.entities++
    }

    // --- episodes (dedupe by (scope, source_hash)) ----------------------
    const episodeIdTaken = new Set(store.episodes.listAll().map((e) => e.id))
    for (const episode of bundle.episodes) {
      const resolvedScopeId = scopeIdMap.get(episode.scopeId) ?? episode.scopeId
      const existing = store.episodes.getBySourceHash(resolvedScopeId, episode.sourceHash)
      if (existing) {
        episodeIdMap.set(episode.id, existing.id)
        skippedDuplicates++
        continue
      }
      let id = episode.id
      if (episodeIdTaken.has(id)) {
        id = newEpisodeId()
        remappedIds++
      }
      store.episodes.insert({ ...episode, id, scopeId: resolvedScopeId })
      episodeIdTaken.add(id)
      episodeIdMap.set(episode.id, id)
      imported.episodes++
    }

    // --- facts (dedupe by (scope, statement_hash); see below) -----------
    // Dedupe matches the DB's own active-hash invariant, NOT the raw display
    // `statement` (plan §11.5/§19): `statement_hash` is the portable, case-
    // insensitive identity, while `statement` preserves original casing, so two
    // machines that captured the same logical fact with different casing share a
    // hash but differ in `statement`. For an ACTIVE bundle fact, any existing
    // ACTIVE row at (scope, statement_hash) IS the duplicate — the partial unique
    // index `idx_facts_active_hash` allows at most one. For a non-active row,
    // multiple rows can share a hash (a supersession chain keeps superseded rows),
    // so match within the hash on status + statement to stay precise.
    const factIdTaken = new Set(store.facts.listAll().map((f) => f.id))
    for (const fact of bundle.facts) {
      const resolvedScopeId = scopeIdMap.get(fact.scopeId) ?? fact.scopeId
      const dupe =
        fact.status === 'active'
          ? store.facts.getActiveByStatementHash(resolvedScopeId, fact.statementHash)
          : store.facts
              .listByStatementHash(resolvedScopeId, fact.statementHash)
              .find((f) => f.status === fact.status && f.statement === fact.statement)
      if (dupe) {
        factIdMap.set(fact.id, dupe.id)
        skippedDuplicates++
        continue
      }
      let id = fact.id
      if (factIdTaken.has(id)) {
        id = newFactId()
        remappedIds++
      }
      const resolved: Fact = {
        ...fact,
        id,
        scopeId: resolvedScopeId,
        subjectEntityId:
          fact.subjectEntityId === null
            ? null
            : (entityIdMap.get(fact.subjectEntityId) ?? fact.subjectEntityId),
        objectEntityId:
          fact.objectEntityId === null
            ? null
            : (entityIdMap.get(fact.objectEntityId) ?? fact.objectEntityId),
      }
      // A bundle row can still violate a destination uniqueness invariant the
      // dedupe above did not anticipate — e.g. a tampered/hand-edited bundle with
      // a `statement_hash` that diverged from its `statement`, colliding on the
      // partial unique index `idx_facts_active_hash`. SQLite would abort the WHOLE
      // transaction (rolling back every imported row). Use a SQLite SAVEPOINT so a
      // UNIQUE violation rolls back only this one insert and degrades to a counted
      // skip; any other error still propagates (and aborts) as before.
      const insertedOk = tryInsertFact(store, resolved)
      if (!insertedOk) {
        skippedConflicts++
        continue
      }
      factIdTaken.add(id)
      factIdMap.set(fact.id, id)
      imported.facts++
    }

    // --- evidence (references fact + episode; dedupe by (fact, quote_hash)) -
    // Evidence has no portable hash of its own beyond quote_hash; dedupe on the
    // resolved (fact_id, episode_id, quote_hash) tuple so re-import is idempotent
    // and an evidence row whose fact/episode was skipped-as-duplicate is not
    // double-attached. Skip evidence whose fact or episode did not resolve.
    const existingEvidenceKeys = new Set(
      store.evidence.listAll().map((e) => evidenceKey(e.factId, e.episodeId, e.quoteHash)),
    )
    const evidenceIdTaken = new Set(store.evidence.listAll().map((e) => e.id))
    for (const ev of bundle.evidence) {
      const resolvedFactId = factIdMap.get(ev.factId)
      const resolvedEpisodeId = episodeIdMap.get(ev.episodeId)
      if (!resolvedFactId || !resolvedEpisodeId) {
        // Dangling reference (its fact/episode was absent from the bundle); the
        // FK would fail. Skip rather than abort the whole import.
        continue
      }
      const key = evidenceKey(resolvedFactId, resolvedEpisodeId, ev.quoteHash)
      if (existingEvidenceKeys.has(key)) {
        skippedDuplicates++
        continue
      }
      let id = ev.id
      if (evidenceIdTaken.has(id)) {
        id = newEvidenceId()
        remappedIds++
      }
      store.evidence.insert({
        ...ev,
        id,
        factId: resolvedFactId,
        episodeId: resolvedEpisodeId,
      })
      evidenceIdTaken.add(id)
      existingEvidenceKeys.add(key)
      imported.evidence++
    }

    // --- edges (nodes are (type,id); remap fact/entity/scope refs) ------
    const edgeIdTaken = new Set(store.edges.listAll().map((e) => e.id))
    const existingEdgeKeys = new Set(store.edges.listAll().map((e) => edgeKey(e)))
    for (const edge of bundle.edges) {
      const resolvedScopeId = scopeIdMap.get(edge.scopeId) ?? edge.scopeId
      const sourceId = remapNodeId(edge.sourceType, edge.sourceId, factIdMap, entityIdMap)
      const targetId = remapNodeId(edge.targetType, edge.targetId, factIdMap, entityIdMap)
      const resolved: Edge = {
        ...edge,
        scopeId: resolvedScopeId,
        sourceId,
        targetId,
      }
      const key = edgeKey(resolved)
      if (existingEdgeKeys.has(key)) {
        skippedDuplicates++
        continue
      }
      let id = edge.id
      if (edgeIdTaken.has(id)) {
        id = newEdgeId()
        remappedIds++
      }
      store.edges.insert({ ...resolved, id })
      edgeIdTaken.add(id)
      existingEdgeKeys.add(key)
      imported.edges++
    }

    // --- supersessions (old/new fact refs; dedupe by (old,new) pair) ----
    const supIdTaken = new Set(store.supersessions.listAll().map((s) => s.id))
    const existingSupKeys = new Set(
      store.supersessions.listAll().map((s) => `${s.oldFactId} ${s.newFactId}`),
    )
    for (const sup of bundle.supersessions) {
      const oldFactId = factIdMap.get(sup.oldFactId)
      const newFactId = factIdMap.get(sup.newFactId)
      if (!oldFactId || !newFactId) {
        continue
      }
      const key = `${oldFactId} ${newFactId}`
      if (existingSupKeys.has(key)) {
        skippedDuplicates++
        continue
      }
      let id = sup.id
      if (supIdTaken.has(id)) {
        id = newSupersessionId()
        remappedIds++
      }
      store.supersessions.insert({ ...sup, id, oldFactId, newFactId })
      supIdTaken.add(id)
      existingSupKeys.add(key)
      imported.supersessions++
    }
  })

  // Rebuild derived indexes AFTER the canonical load commits (plan §12.2). FTS
  // is always rebuilt by the caller's reindex path; vectors only when an
  // embedder is configured. `rebuildVectors` returns null when none is.
  const vectorOutcome = await deps.rebuildVectors()
  const result: ImportResult = { imported, skippedDuplicates, remappedIds, skippedConflicts }
  if (vectorOutcome) {
    result.vectorsRebuilt = vectorOutcome
    // §19 mismatch warning: an embedder IS configured but differs from the one
    // the bundle was exported with, so the facts were re-embedded into a
    // DIFFERENT semantic space than the bundle's vectors lived in. Surface it.
    if (
      deps.liveEmbedding &&
      bundle.embedding &&
      embeddingDiffers(deps.liveEmbedding, bundle.embedding)
    ) {
      result.embeddingMismatch = {
        reembeddedUnder: deps.liveEmbedding,
        bundleEmbedding: bundle.embedding,
      }
    }
  } else {
    result.reembedNeeded = {
      reason:
        'no embedder configured: vector index left empty. Configure an embedder and run reindex to regenerate vectors.',
      ...(bundle.embedding ? { embedding: bundle.embedding } : {}),
    }
  }
  return result
}

/** Whether two embedding provenances differ in provider, model, or dimension. */
function embeddingDiffers(a: BundleEmbedding, b: BundleEmbedding): boolean {
  return a.provider !== b.provider || a.model !== b.model || a.dimension !== b.dimension
}

/**
 * Insert a fact, degrading a UNIQUE-constraint violation to a `false` return
 * instead of aborting the surrounding transaction (plan §19 robustness). Runs
 * the insert inside a SQLite SAVEPOINT so a constraint failure rolls back only
 * this row; the outer import transaction (and every already-imported row) is
 * preserved. Any non-UNIQUE error is re-thrown so genuine failures still abort.
 */
function tryInsertFact(store: Store, fact: Fact): boolean {
  store.db.exec('SAVEPOINT naru_fact_insert')
  try {
    store.facts.insert(fact)
    store.db.exec('RELEASE naru_fact_insert')
    return true
  } catch (error) {
    store.db.exec('ROLLBACK TO naru_fact_insert')
    store.db.exec('RELEASE naru_fact_insert')
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return false
    }
    throw error
  }
}

/** Stable dedupe key for an evidence row. */
function evidenceKey(factId: string, episodeId: string, quoteHash: string | null): string {
  return `${factId} ${episodeId} ${quoteHash ?? ''}`
}

/** Stable dedupe key for an edge (scope + both endpoints + predicate). */
function edgeKey(edge: Edge): string {
  return [
    edge.scopeId,
    edge.sourceType,
    edge.sourceId,
    edge.predicate,
    edge.targetType,
    edge.targetId,
  ].join(' ')
}

/**
 * Remap an edge endpoint id through the fact/entity id maps based on its node
 * type. Other node types (or unmapped ids) pass through unchanged.
 */
function remapNodeId(
  nodeType: string,
  nodeId: string,
  factIdMap: Map<string, string>,
  entityIdMap: Map<string, string>,
): string {
  if (nodeType === 'fact') {
    return factIdMap.get(nodeId) ?? nodeId
  }
  if (nodeType === 'entity') {
    return entityIdMap.get(nodeId) ?? nodeId
  }
  return nodeId
}
