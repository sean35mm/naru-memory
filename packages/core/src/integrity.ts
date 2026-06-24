import { newScopeId, nowIso, scopeKey } from '@naru/schema'
import type { Store } from '@naru/store-sqlite'

/**
 * The kinds of integrity problem {@link checkIntegrity} can report. Stable
 * string identifiers so callers (CLI, status) can branch/aggregate without
 * parsing prose.
 */
export type IntegrityProblemKind =
  | 'pragma_integrity_check'
  | 'foreign_key_violation'
  | 'orphan_evidence_fact'
  | 'orphan_evidence_episode'
  | 'orphan_fact_vectors'
  | 'orphan_edges'
  | 'orphan_supersessions'
  | 'orphan_by_scope'
  | 'dangling_entity_link'
  | 'facts_fts_extra'
  | 'facts_fts_missing'
  | 'entities_fts_extra'
  | 'entities_fts_missing'

/**
 * One detected integrity problem. Privacy-safe by construction (plan §18): it
 * carries the problem `kind`, a `count`, and a bounded sample of opaque row ids
 * — NEVER fact statements, episode text, evidence quotes, or entity names.
 *
 * `sampleIds` is capped at {@link SAMPLE_LIMIT}; `count` is the true total so a
 * caller can see the full magnitude without the full id list.
 */
export interface IntegrityProblem {
  kind: IntegrityProblemKind
  count: number
  sampleIds: string[]
}

/**
 * Structured integrity report (plan §22 index staleness / privacy delete gaps).
 * `ok` is true iff `problems` is empty. Contains ids/counts/kinds only — no
 * memory content.
 */
export interface IntegrityReport {
  ok: boolean
  problems: IntegrityProblem[]
}

/** What a {@link repair} run changed. All values are counts (privacy-safe). */
export interface RepairResult {
  /** FTS tables were dropped and rebuilt from canonical rows. */
  ftsRebuilt: boolean
  /** Vector index outcome: rebuilt count when an embedder was configured, else null. */
  vectorsRebuilt: { embedded: number } | null
  /** Orphaned derived/reference rows pruned, by kind. */
  pruned: {
    evidence: number
    factVectors: number
    edges: number
    supersessions: number
  }
  /** Facts whose dangling entity link(s) were cleared to NULL (canonical kept). */
  danglingEntityLinksCleared: number
  /**
   * Canonical rows whose `scope_id` pointed at a missing scope and were RE-HOMED
   * onto a synthetic recovered scope (never deleted), by table. Non-zero only
   * when orphan-by-scope corruption was present (plan §22, §12.2).
   */
  rehomedByScope: { facts: number; episodes: number; entities: number }
  /** A post-repair integrity report (should be `ok: true` for fixable corruption). */
  report: IntegrityReport
}

/** How {@link repair} regenerates derived indexes (injected by the facade). */
export interface RepairDeps {
  /**
   * Rebuild derived indexes from canonical rows (plan §12.2): FTS always, and
   * vectors only when an embedder is configured. Returns the embedded count, or
   * `null` when no embedder is configured (vector index left empty). Mirrors the
   * bundle-import rebuild seam so both write paths share one rebuild contract.
   */
  rebuildIndexes(): Promise<{ embedded: number } | null>
}

/** Max ids surfaced per problem; `count` still reports the true total. */
const SAMPLE_LIMIT = 20

/** `index_state.index_version` stamped by a successful repair rebuild. */
const INDEX_VERSION = '1'

/**
 * Synthetic "lost-and-found" scope that orphan-by-scope canonical rows are
 * re-homed onto by {@link repair} (plan §22/§12.2). Uses the `agent` scope type
 * (a legitimate stored type) with a fixed, unique key so the recovered scope is
 * created at most once and is easy to spot/triage in `naru list`.
 */
const RECOVERED_SCOPE_TYPE = 'agent' as const
const RECOVERED_SCOPE_KEY_PART = 'naru-recovered'
const RECOVERED_SCOPE_NAME = 'Recovered (orphaned by missing scope)'

/**
 * Run DB integrity checks over the canonical + derived schema (plan §22, §12.2).
 *
 * Runs SQLite's native `PRAGMA integrity_check` + `PRAGMA foreign_key_check`
 * first (physical/FK corruption), then logical join probes: orphan evidence
 * (missing fact/episode), orphan `fact_vectors`, orphan edges, supersessions
 * pointing at missing facts, FTS membership drift (extra/missing rows in
 * `facts_fts`/`entities_fts` vs canonical), and dangling entity links on facts.
 *
 * The returned report is privacy-safe: ids + counts + kinds only, never any
 * fact/episode/evidence/entity TEXT (plan §18). Read-only.
 */
export function checkIntegrity(store: Store): IntegrityReport {
  const problems: IntegrityProblem[] = []
  const add = (kind: IntegrityProblemKind, ids: string[]): void => {
    if (ids.length > 0) {
      problems.push({ kind, count: ids.length, sampleIds: ids.slice(0, SAMPLE_LIMIT) })
    }
  }

  // Native PRAGMAs first (physical structure + declared FKs).
  const pragmaMessages = store.integrity.pragmaIntegrityCheck()
  if (pragmaMessages.length > 0) {
    // The pragma yields structural messages, not row content; surface only a
    // count + the messages as opaque "sample ids" so nothing leaks.
    problems.push({
      kind: 'pragma_integrity_check',
      count: pragmaMessages.length,
      sampleIds: pragmaMessages.slice(0, SAMPLE_LIMIT),
    })
  }
  const fkViolations = store.integrity.foreignKeyViolationCount()
  if (fkViolations > 0) {
    problems.push({ kind: 'foreign_key_violation', count: fkViolations, sampleIds: [] })
  }

  // Logical orphan / drift probes (ids only).
  add('orphan_evidence_fact', store.integrity.orphanEvidenceByFact())
  add('orphan_evidence_episode', store.integrity.orphanEvidenceByEpisode())
  add('orphan_fact_vectors', store.integrity.orphanFactVectors())
  add('orphan_edges', store.integrity.orphanEdges())
  add('orphan_supersessions', store.integrity.orphanSupersessions())
  // Canonical rows pointing at a missing scope (orphan-by-scope). Surfaced as a
  // single kind across facts/episodes/entities; repair re-homes them (§22/§12.2).
  add('orphan_by_scope', [
    ...store.integrity.orphanByScopeFactIds(),
    ...store.integrity.orphanByScopeEpisodeIds(),
    ...store.integrity.orphanByScopeEntityIds(),
  ])
  add('dangling_entity_link', store.integrity.danglingEntityLinkFactIds())
  add('facts_fts_extra', store.integrity.factsFtsExtra())
  add('facts_fts_missing', store.integrity.factsFtsMissing())
  add('entities_fts_extra', store.integrity.entitiesFtsExtra())
  add('entities_fts_missing', store.integrity.entitiesFtsMissing())

  return { ok: problems.length === 0, problems }
}

/**
 * Repair derived/orphan state from CANONICAL data (plan §22, §12.2). A WRITE:
 * the caller (Naru facade) is responsible for §12.3 write coordination.
 *
 * What it does, all idempotently and inside a single transaction for the
 * pruning/link-clearing pass:
 * - Prunes orphaned derived rows (`fact_vectors`) and orphaned reference rows
 *   (`evidence`/`edges`/`supersessions`) whose canonical target is missing.
 * - Clears dangling entity links on facts to NULL (canonical fact preserved).
 * - Rebuilds the FTS tables from canonical rows (always) and the vector index
 *   (only when an embedder is configured — via {@link RepairDeps.rebuildIndexes}),
 *   which also removes any FTS drift (extra/missing membership).
 * - Recomputes `index_state` for the rebuilt derived indexes (§22 staleness).
 *
 * Never deletes a canonical fact/entity/episode/scope. Returns what it fixed
 * plus a fresh post-repair {@link checkIntegrity} report (counts/ids only).
 */
export async function repair(store: Store, deps: RepairDeps): Promise<RepairResult> {
  // Pass 1: re-home orphan-by-scope rows, prune orphans + clear dangling links in
  // one transaction (writes). Re-homing FIRST makes those canonical rows
  // referentially valid so the Pass-2 index rebuild indexes them under the
  // recovered scope (plan §22/§12.2) instead of dropping them; it never deletes
  // a canonical row.
  const pass1 = store.transaction(() => {
    const rehomedByScope = store.integrity.rehomeOrphanByScopeRows({
      id: newScopeId(),
      type: RECOVERED_SCOPE_TYPE,
      name: RECOVERED_SCOPE_NAME,
      key: scopeKey(RECOVERED_SCOPE_TYPE, RECOVERED_SCOPE_KEY_PART),
      now: nowIso(),
    })
    const orphanEvidence = [
      ...store.integrity.orphanEvidenceByFact(),
      ...store.integrity.orphanEvidenceByEpisode(),
    ]
    // De-dupe ids that fail both fact and episode reference.
    const evidenceIds = [...new Set(orphanEvidence)]
    const evidence = store.integrity.deleteEvidenceByIds(evidenceIds)
    const factVectors = store.integrity.deleteFactVectorsByFactIds(
      store.integrity.orphanFactVectors(),
    )
    const edges = store.integrity.deleteEdgesByIds(store.integrity.orphanEdges())
    const supersessions = store.integrity.deleteSupersessionsByIds(
      store.integrity.orphanSupersessions(),
    )
    const danglingEntityLinksCleared = store.integrity.clearDanglingEntityLinks(
      store.integrity.danglingEntityLinkFactIds(),
    )
    return {
      rehomedByScope,
      evidence,
      factVectors,
      edges,
      supersessions,
      danglingEntityLinksCleared,
    }
  })
  const pruned = pass1

  // Pass 2: rebuild derived indexes from canonical rows (FTS always; vectors
  // only when an embedder is configured). This is the same rebuild seam the
  // bundle import uses, so FTS drift and stale/extra vectors are resolved by a
  // full regenerate rather than per-row patching (plan §12.2).
  const vectorsRebuilt = await deps.rebuildIndexes()

  // Pass 3: recompute index_state freshness for the rebuilt derived indexes
  // (plan §11.10, §22 index staleness). Writes only bookkeeping rows.
  const now = nowIso()
  store.transaction(() => {
    store.indexState.upsert({
      indexName: 'facts_fts',
      indexVersion: INDEX_VERSION,
      sourceWatermark: null,
      sourceHash: null,
      status: 'fresh',
      lastRebuiltAt: now,
      error: null,
      metadata: {},
    })
    store.indexState.upsert({
      indexName: 'entities_fts',
      indexVersion: INDEX_VERSION,
      sourceWatermark: null,
      sourceHash: null,
      status: 'fresh',
      lastRebuiltAt: now,
      error: null,
      metadata: {},
    })
    if (vectorsRebuilt) {
      store.indexState.upsert({
        indexName: 'fact_vectors',
        indexVersion: INDEX_VERSION,
        sourceWatermark: null,
        sourceHash: null,
        status: 'fresh',
        lastRebuiltAt: now,
        error: null,
        metadata: {},
      })
    }
  })

  return {
    ftsRebuilt: true,
    vectorsRebuilt,
    pruned: {
      evidence: pruned.evidence,
      factVectors: pruned.factVectors,
      edges: pruned.edges,
      supersessions: pruned.supersessions,
    },
    danglingEntityLinksCleared: pruned.danglingEntityLinksCleared,
    rehomedByScope: pruned.rehomedByScope,
    report: checkIntegrity(store),
  }
}
