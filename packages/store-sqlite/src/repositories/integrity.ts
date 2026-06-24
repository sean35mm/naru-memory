import type Database from 'better-sqlite3'

/**
 * SQL-level integrity probes and orphan pruning over the canonical + derived
 * schema (plan §22 index staleness / privacy delete gaps, §12.2 rebuildability).
 *
 * Every method here returns ONLY ids/counts — never fact statements, episode
 * text, evidence quotes, or entity names (plan §18 privacy: observability emits
 * counts/ids/hashes/types only). The higher-level core integrity report
 * (`@naru/core`) further bounds the id samples it surfaces.
 *
 * Two probe shapes:
 * - Native PRAGMAs (`integrity_check`, `foreign_key_check`) for physical/FK
 *   corruption.
 * - Logical join probes that find DERIVED or reference rows pointing at a
 *   missing CANONICAL row (orphans) and FTS membership drift.
 *
 * Pruning removes ONLY derived rows (FTS/vectors) and orphaned reference rows
 * (evidence/edges/supersessions) whose canonical target no longer exists. It
 * NEVER deletes a canonical fact/entity/episode/scope (plan §12.2: repair fixes
 * derived state, canonical data is authoritative).
 */
export class IntegrityRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * `PRAGMA integrity_check`: SQLite's own physical/structural check. Returns
   * `[]` when the database reports `ok`, otherwise the raw problem strings (kept
   * for diagnostics; they describe page/index structure, never row content).
   */
  pragmaIntegrityCheck(): string[] {
    const rows = this.db.pragma('integrity_check') as { integrity_check: string }[]
    const messages = rows.map((r) => r.integrity_check)
    if (messages.length === 1 && messages[0] === 'ok') {
      return []
    }
    return messages
  }

  /**
   * `PRAGMA foreign_key_check`: rows that violate a declared foreign key. The
   * pragma yields `{ table, rowid, parent, fkid }` — table names and rowids
   * only, no column values — so it is privacy-safe to count/surface. Returns the
   * count of violating rows (0 when clean).
   */
  foreignKeyViolationCount(): number {
    const rows = this.db.pragma('foreign_key_check') as unknown[]
    return rows.length
  }

  /** Ids of `evidence` rows whose `fact_id` references a missing fact. */
  orphanEvidenceByFact(): string[] {
    return this.idColumn(
      `SELECT e.id AS id FROM evidence e
        LEFT JOIN facts f ON f.id = e.fact_id
       WHERE f.id IS NULL`,
    )
  }

  /** Ids of `evidence` rows whose `episode_id` references a missing episode. */
  orphanEvidenceByEpisode(): string[] {
    return this.idColumn(
      `SELECT e.id AS id FROM evidence e
        LEFT JOIN episodes ep ON ep.id = e.episode_id
       WHERE ep.id IS NULL`,
    )
  }

  /** `fact_vectors.fact_id` values whose owning fact no longer exists. */
  orphanFactVectors(): string[] {
    return this.idColumn(
      `SELECT fv.fact_id AS id FROM fact_vectors fv
        LEFT JOIN facts f ON f.id = fv.fact_id
       WHERE f.id IS NULL`,
    )
  }

  /**
   * Ids of `edges` whose `fact`/`entity` endpoint references a missing canonical
   * row. Only `'fact'` and `'entity'` endpoints are checked against
   * `facts`/`entities`; other endpoint types carry no canonical-row contract.
   */
  orphanEdges(): string[] {
    return this.idColumn(
      `SELECT id FROM edges
        WHERE (source_type = 'fact'   AND source_id NOT IN (SELECT id FROM facts))
           OR (target_type = 'fact'   AND target_id NOT IN (SELECT id FROM facts))
           OR (source_type = 'entity' AND source_id NOT IN (SELECT id FROM entities))
           OR (target_type = 'entity' AND target_id NOT IN (SELECT id FROM entities))`,
    )
  }

  /** Ids of `supersessions` whose `old_fact_id`/`new_fact_id` is missing. */
  orphanSupersessions(): string[] {
    return this.idColumn(
      `SELECT s.id AS id FROM supersessions s
        WHERE s.old_fact_id NOT IN (SELECT id FROM facts)
           OR s.new_fact_id NOT IN (SELECT id FROM facts)`,
    )
  }

  /**
   * Ids of canonical `facts` whose `scope_id` references a MISSING scope row
   * (orphan-by-scope corruption: external tampering, a partial/inconsistent
   * restore, or a future write-path bug). `facts.scope_id` is NOT NULL, so any
   * value not present in `scopes` is an orphan. Such a fact is invisible to the
   * scope-joined FTS/vector rebuild and search, so it is unsearchable until
   * re-homed (plan §22 index staleness). Repair re-homes — never deletes — it.
   */
  orphanByScopeFactIds(): string[] {
    return this.idColumn('SELECT id FROM facts WHERE scope_id NOT IN (SELECT id FROM scopes)')
  }

  /** Ids of canonical `episodes` whose NOT-NULL `scope_id` references a missing scope. */
  orphanByScopeEpisodeIds(): string[] {
    return this.idColumn('SELECT id FROM episodes WHERE scope_id NOT IN (SELECT id FROM scopes)')
  }

  /**
   * Ids of canonical `entities` whose NON-NULL `scope_id` references a missing
   * scope. A NULL `scope_id` is the legitimate "global" entity (plan §11.4), so
   * it is excluded — only a non-null id pointing at a vanished scope is an orphan.
   */
  orphanByScopeEntityIds(): string[] {
    return this.idColumn(
      `SELECT id FROM entities
        WHERE scope_id IS NOT NULL AND scope_id NOT IN (SELECT id FROM scopes)`,
    )
  }

  /**
   * Fact ids with a dangling entity link: `subject_entity_id` or
   * `object_entity_id` references an entity row that no longer exists. The link
   * is canonical (a column on `facts`), so repair clears the dangling pointer to
   * NULL rather than deleting the fact (plan §12.2: never delete a canonical
   * fact).
   */
  danglingEntityLinkFactIds(): string[] {
    return this.idColumn(
      `SELECT id FROM facts
        WHERE (subject_entity_id IS NOT NULL
               AND subject_entity_id NOT IN (SELECT id FROM entities))
           OR (object_entity_id IS NOT NULL
               AND object_entity_id NOT IN (SELECT id FROM entities))`,
    )
  }

  /**
   * `facts_fts` rows whose `fact_id` no longer maps to a fact (FTS drift:
   * stale/extra membership). Returns the offending `fact_id` values.
   */
  factsFtsExtra(): string[] {
    return this.idColumn(
      `SELECT facts_fts.fact_id AS id FROM facts_fts
        LEFT JOIN facts f ON f.id = facts_fts.fact_id
       WHERE f.id IS NULL`,
    )
  }

  /** Fact ids present in canonical `facts` but absent from `facts_fts` (drift). */
  factsFtsMissing(): string[] {
    return this.idColumn(
      `SELECT f.id AS id FROM facts f
        LEFT JOIN facts_fts ON facts_fts.fact_id = f.id
       WHERE facts_fts.fact_id IS NULL`,
    )
  }

  /** `entities_fts` rows whose `entity_id` no longer maps to an entity (drift). */
  entitiesFtsExtra(): string[] {
    return this.idColumn(
      `SELECT entities_fts.entity_id AS id FROM entities_fts
        LEFT JOIN entities e ON e.id = entities_fts.entity_id
       WHERE e.id IS NULL`,
    )
  }

  /** Entity ids present in canonical `entities` but absent from `entities_fts`. */
  entitiesFtsMissing(): string[] {
    return this.idColumn(
      `SELECT e.id AS id FROM entities e
        LEFT JOIN entities_fts ON entities_fts.entity_id = e.id
       WHERE entities_fts.entity_id IS NULL`,
    )
  }

  // --- pruning (derived/orphan rows only; never canonical facts) ----------

  /** Delete the given evidence rows by id. Returns the number removed. */
  deleteEvidenceByIds(ids: string[]): number {
    return this.deleteByIds('evidence', ids)
  }

  /** Delete the given edge rows by id. Returns the number removed. */
  deleteEdgesByIds(ids: string[]): number {
    return this.deleteByIds('edges', ids)
  }

  /** Delete the given supersession rows by id. Returns the number removed. */
  deleteSupersessionsByIds(ids: string[]): number {
    return this.deleteByIds('supersessions', ids)
  }

  /** Delete orphaned `fact_vectors` rows by their `fact_id`. Returns count removed. */
  deleteFactVectorsByFactIds(factIds: string[]): number {
    let removed = 0
    const stmt = this.db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?')
    for (const id of factIds) {
      removed += stmt.run(id).changes
    }
    return removed
  }

  /**
   * Re-home canonical rows (`facts`/`episodes`/`entities`) whose `scope_id`
   * references a MISSING scope onto a synthetic recovered ("lost-and-found")
   * scope so they become referentially valid and searchable again, WITHOUT
   * deleting any canonical data (plan §12.2: repair never drops a canonical
   * fact). The recovered scope is created on demand (idempotent get-or-create on
   * its unique key) and the orphan rows' `scope_id` is rewritten to it. Returns
   * per-table counts of rewritten rows; all zero when there is nothing to fix.
   *
   * Runs the scope insert + rewrites inside one SQLite SAVEPOINT so the orphan
   * rows are never momentarily pointed at a not-yet-inserted scope under FK
   * enforcement. Caller is expected to be inside the repair write path.
   */
  rehomeOrphanByScopeRows(recovered: {
    id: string
    type: string
    name: string
    key: string
    now: string
  }): { facts: number; episodes: number; entities: number } {
    const orphanFacts = this.orphanByScopeFactIds()
    const orphanEpisodes = this.orphanByScopeEpisodeIds()
    const orphanEntities = this.orphanByScopeEntityIds()
    if (orphanFacts.length === 0 && orphanEpisodes.length === 0 && orphanEntities.length === 0) {
      return { facts: 0, episodes: 0, entities: 0 }
    }

    this.db.exec('SAVEPOINT naru_rehome')
    try {
      // Get-or-create the recovered scope by its unique key (idempotent).
      const existing = this.db.prepare('SELECT id FROM scopes WHERE key = ?').get(recovered.key) as
        | { id: string }
        | undefined
      const recoveredId = existing?.id ?? recovered.id
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO scopes (id, type, name, key, parent_scope_id, metadata_json, created_at, updated_at)
             VALUES (@id, @type, @name, @key, NULL, '{}', @now, @now)`,
          )
          .run({
            id: recoveredId,
            type: recovered.type,
            name: recovered.name,
            key: recovered.key,
            now: recovered.now,
          })
      }
      const facts = this.rewriteScopeId('facts', orphanFacts, recoveredId)
      const episodes = this.rewriteScopeId('episodes', orphanEpisodes, recoveredId)
      const entities = this.rewriteScopeId('entities', orphanEntities, recoveredId)
      this.db.exec('RELEASE naru_rehome')
      return { facts, episodes, entities }
    } catch (error) {
      this.db.exec('ROLLBACK TO naru_rehome')
      this.db.exec('RELEASE naru_rehome')
      throw error
    }
  }

  /** Point the given rows' `scope_id` at `scopeId`. Returns rows updated. */
  private rewriteScopeId(table: string, ids: string[], scopeId: string): number {
    if (ids.length === 0) {
      return 0
    }
    // `table` is an internal literal (never user input); ids/scopeId are bound.
    const stmt = this.db.prepare(`UPDATE ${table} SET scope_id = ? WHERE id = ?`)
    let updated = 0
    for (const id of ids) {
      updated += stmt.run(scopeId, id).changes
    }
    return updated
  }

  /**
   * Clear a fact's dangling entity link(s): set `subject_entity_id` /
   * `object_entity_id` to NULL when they point at a missing entity. Returns the
   * number of fact rows touched. Canonical fact row is preserved.
   */
  clearDanglingEntityLinks(factIds: string[]): number {
    let touched = 0
    const stmt = this.db.prepare(
      `UPDATE facts
          SET subject_entity_id =
                CASE WHEN subject_entity_id NOT IN (SELECT id FROM entities)
                     THEN NULL ELSE subject_entity_id END,
              object_entity_id =
                CASE WHEN object_entity_id NOT IN (SELECT id FROM entities)
                     THEN NULL ELSE object_entity_id END,
              updated_at = @now
        WHERE id = @id`,
    )
    const now = new Date().toISOString()
    for (const id of factIds) {
      touched += stmt.run({ id, now }).changes
    }
    return touched
  }

  // --- internals ----------------------------------------------------------

  private idColumn(sql: string): string[] {
    const rows = this.db.prepare(sql).all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  private deleteByIds(table: string, ids: string[]): number {
    if (ids.length === 0) {
      return 0
    }
    // `table` is an internal literal (never user input); ids are bound params.
    const stmt = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`)
    let removed = 0
    for (const id of ids) {
      removed += stmt.run(id).changes
    }
    return removed
  }
}
