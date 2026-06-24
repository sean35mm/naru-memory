import type { Edge } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, stringifyRecord } from './json'

/** An `edges` table row in snake_case column form. */
interface EdgeRow {
  id: string
  scope_id: string
  source_type: string
  source_id: string
  predicate: string
  target_type: string
  target_id: string
  confidence: number | null
  metadata_json: string
  created_at: string
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    scopeId: row.scope_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    predicate: row.predicate,
    targetType: row.target_type,
    targetId: row.target_id,
    confidence: row.confidence,
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
  }
}

/** Persistence for typed graph edges (plan §11.7). */
export class EdgesRepository {
  constructor(private readonly db: Database.Database) {}

  insert(edge: Edge): Edge {
    this.db
      .prepare(
        `INSERT INTO edges
           (id, scope_id, source_type, source_id, predicate, target_type, target_id,
            confidence, metadata_json, created_at)
         VALUES
           (@id, @scopeId, @sourceType, @sourceId, @predicate, @targetType, @targetId,
            @confidence, @metadataJson, @createdAt)`,
      )
      .run({
        id: edge.id,
        scopeId: edge.scopeId,
        sourceType: edge.sourceType,
        sourceId: edge.sourceId,
        predicate: edge.predicate,
        targetType: edge.targetType,
        targetId: edge.targetId,
        confidence: edge.confidence,
        metadataJson: stringifyRecord(edge.metadata),
        createdAt: edge.createdAt,
      })
    return edge
  }

  /** Edges originating from a node `(type, id)`. */
  listBySource(sourceType: string, sourceId: string): Edge[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE source_type = ? AND source_id = ? ORDER BY created_at')
      .all(sourceType, sourceId) as EdgeRow[]
    return rows.map(rowToEdge)
  }

  /**
   * Purge every edge touching a node `(type, id)` on either end (used by
   * destructive forget so dangling edges don't survive, plan §18.2).
   */
  deleteBySourceOrTarget(nodeType: string, nodeId: string): void {
    this.db
      .prepare(
        `DELETE FROM edges
          WHERE (source_type = ? AND source_id = ?)
             OR (target_type = ? AND target_id = ?)`,
      )
      .run(nodeType, nodeId, nodeType, nodeId)
  }

  /** All edges (used by bundle export, plan §19). Insertion order. */
  listAll(): Edge[] {
    const rows = this.db.prepare('SELECT * FROM edges ORDER BY created_at').all() as EdgeRow[]
    return rows.map(rowToEdge)
  }
}
