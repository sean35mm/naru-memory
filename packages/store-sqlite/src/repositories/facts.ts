import type { Fact, FactStatus } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, stringifyRecord } from './json'

/** A `facts` table row in snake_case column form. */
interface FactRow {
  id: string
  scope_id: string
  subject_entity_id: string | null
  predicate: string
  object_entity_id: string | null
  object_value: string | null
  statement: string
  statement_hash: string
  confidence: number
  status: string
  valid_from: string | null
  valid_to: string | null
  observed_at: string
  created_at: string
  updated_at: string
  metadata_json: string
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    scopeId: row.scope_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    objectEntityId: row.object_entity_id,
    objectValue: row.object_value,
    statement: row.statement,
    statementHash: row.statement_hash,
    confidence: row.confidence,
    status: row.status as FactStatus,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseRecord(row.metadata_json),
  }
}

/** A fact joined with its BM25 relevance score from an FTS search. */
export interface FactSearchHit {
  fact: Fact
  /** SQLite `bm25()` score: lower (more negative) is more relevant. */
  bm25: number
}

/**
 * Persistence for facts (plan §11.5), keeping `facts_fts` in sync so BM25
 * text retrieval (plan §14.1) and the current view (plan §14.3) are derivable
 * and rebuildable from canonical rows.
 *
 * The FTS row carries `statement`, `predicate`, an `entity_text` blob (subject
 * + object entity names + literal object value, supplied by the caller during
 * indexing since entity resolution lives above the store), and `scope_key`
 * (the fact's owning `scopeKey`) so scope filtering can run inside the MATCH.
 */
export class FactsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(fact: Fact): Fact {
    this.db
      .prepare(
        `INSERT INTO facts
           (id, scope_id, subject_entity_id, predicate, object_entity_id, object_value,
            statement, statement_hash, confidence, status, valid_from, valid_to,
            observed_at, created_at, updated_at, metadata_json)
         VALUES
           (@id, @scopeId, @subjectEntityId, @predicate, @objectEntityId, @objectValue,
            @statement, @statementHash, @confidence, @status, @validFrom, @validTo,
            @observedAt, @createdAt, @updatedAt, @metadataJson)`,
      )
      .run({
        id: fact.id,
        scopeId: fact.scopeId,
        subjectEntityId: fact.subjectEntityId,
        predicate: fact.predicate,
        objectEntityId: fact.objectEntityId,
        objectValue: fact.objectValue,
        statement: fact.statement,
        statementHash: fact.statementHash,
        confidence: fact.confidence,
        status: fact.status,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
        observedAt: fact.observedAt,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
        metadataJson: stringifyRecord(fact.metadata),
      })
    return fact
  }

  getById(id: string): Fact | undefined {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as FactRow | undefined
    return row ? rowToFact(row) : undefined
  }

  /**
   * Look up the single ACTIVE fact for a `(scope, statement_hash)` dedupe key
   * (plan §13.5). A statement_hash legitimately recurs across rows — every
   * supersession chain keeps the old `superseded` row alongside the new one —
   * so this restricts to `status = 'active'` to stay deterministic (at most one
   * active per hash). Use {@link listByStatementHash} for the full set.
   */
  getActiveByStatementHash(scopeId: string, statementHash: string): Fact | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM facts WHERE scope_id = ? AND statement_hash = ? AND status = 'active' LIMIT 1",
      )
      .get(scopeId, statementHash) as FactRow | undefined
    return row ? rowToFact(row) : undefined
  }

  /** All facts sharing a `(scope, statement_hash)` key, oldest observed first. */
  listByStatementHash(scopeId: string, statementHash: string): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM facts WHERE scope_id = ? AND statement_hash = ? ORDER BY observed_at')
      .all(scopeId, statementHash) as FactRow[]
    return rows.map(rowToFact)
  }

  listByScopeStatus(scopeId: string, status: FactStatus): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM facts WHERE scope_id = ? AND status = ? ORDER BY observed_at')
      .all(scopeId, status) as FactRow[]
    return rows.map(rowToFact)
  }

  /** Update a fact's lifecycle status (e.g. mark `superseded`) (plan §13.6). */
  updateStatus(id: string, status: FactStatus): void {
    this.db
      .prepare('UPDATE facts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
  }

  deleteById(id: string): void {
    this.unindexFact(id)
    // Drop the derived vector explicitly (plan §18.2 purge). `fact_vectors` also
    // declares ON DELETE CASCADE, but FK cascade only fires when the pragma is
    // enabled, so delete here too to guarantee the vector never lingers.
    this.db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(id)
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(id)
  }

  /** Insert a fact's row into `facts_fts`. `entityText` is the joined entity names/value. */
  indexFact(fact: Fact, scopeKeyValue: string, entityText: string): void {
    this.db
      .prepare(
        `INSERT INTO facts_fts (fact_id, statement, predicate, entity_text, scope_key)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(fact.id, fact.statement, fact.predicate, entityText, scopeKeyValue)
  }

  /** Remove a fact's row from `facts_fts`. */
  unindexFact(factId: string): void {
    this.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(factId)
  }

  /**
   * BM25 text search over `facts_fts`, filtered to the allowed scope keys
   * (plan §9.4: scope filter before ranking). Returns facts with their bm25
   * score, lowest (most relevant) first. Returns [] for an empty scope set.
   */
  ftsSearch(scopeKeys: string[], query: string, limit = 20): FactSearchHit[] {
    if (scopeKeys.length === 0) {
      return []
    }
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT f.*, bm25(facts_fts) AS bm25_score
           FROM facts_fts
           JOIN facts f ON f.id = facts_fts.fact_id
          WHERE facts_fts MATCH ?
            AND facts_fts.scope_key IN (${placeholders})
          ORDER BY bm25_score ASC
          LIMIT ?`,
      )
      .all(query, ...scopeKeys, limit) as (FactRow & { bm25_score: number })[]
    return rows.map((row) => ({ fact: rowToFact(row), bm25: row.bm25_score }))
  }

  /**
   * Current view (plan §14.3): active facts only within the allowed scope keys,
   * excluding `deleted`/`rejected` and superseded facts. Most recently observed
   * first. Returns [] for an empty scope set.
   */
  currentView(scopeKeys: string[], limit = 50): Fact[] {
    if (scopeKeys.length === 0) {
      return []
    }
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT f.* FROM facts f
           JOIN scopes s ON s.id = f.scope_id
          WHERE f.status = 'active'
            AND s.key IN (${placeholders})
          ORDER BY f.observed_at DESC
          LIMIT ?`,
      )
      .all(...scopeKeys, limit) as FactRow[]
    return rows.map(rowToFact)
  }

  /** All facts (used by reindex to rebuild the FTS table). */
  listAll(): Fact[] {
    const rows = this.db.prepare('SELECT * FROM facts').all() as FactRow[]
    return rows.map(rowToFact)
  }

  /**
   * All facts with the given status across EVERY scope, enumerated directly from
   * `facts` (not by walking the `scopes` table). Used by vector reindex so a
   * canonical fact whose `scope_id` references a missing scope is still
   * re-embedded rather than silently skipped — a `scopes`-driven walk would drop
   * it from the vector index forever (plan §22 index staleness, §12.2).
   */
  listAllByStatus(status: FactStatus): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM facts WHERE status = ? ORDER BY observed_at')
      .all(status) as FactRow[]
    return rows.map(rowToFact)
  }

  /** Clear `facts_fts` so it can be fully rebuilt from canonical (used by reindex). */
  clearFts(): void {
    this.db.exec('DELETE FROM facts_fts')
  }
}
