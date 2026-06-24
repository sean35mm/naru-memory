import type { Supersession } from '@naru/schema'
import type Database from 'better-sqlite3'

/** A `supersessions` table row in snake_case column form. */
interface SupersessionRow {
  id: string
  old_fact_id: string
  new_fact_id: string
  reason: string | null
  confidence: number | null
  created_at: string
}

function rowToSupersession(row: SupersessionRow): Supersession {
  return {
    id: row.id,
    oldFactId: row.old_fact_id,
    newFactId: row.new_fact_id,
    reason: row.reason,
    confidence: row.confidence,
    createdAt: row.created_at,
  }
}

/** Persistence for non-destructive fact supersession links (plan §11.8). */
export class SupersessionsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(supersession: Supersession): Supersession {
    this.db
      .prepare(
        `INSERT INTO supersessions (id, old_fact_id, new_fact_id, reason, confidence, created_at)
         VALUES (@id, @oldFactId, @newFactId, @reason, @confidence, @createdAt)`,
      )
      .run({
        id: supersession.id,
        oldFactId: supersession.oldFactId,
        newFactId: supersession.newFactId,
        reason: supersession.reason,
        confidence: supersession.confidence,
        createdAt: supersession.createdAt,
      })
    return supersession
  }

  /** Supersession links where the given fact is the superseded (old) one. */
  listByOld(oldFactId: string): Supersession[] {
    const rows = this.db
      .prepare('SELECT * FROM supersessions WHERE old_fact_id = ? ORDER BY created_at')
      .all(oldFactId) as SupersessionRow[]
    return rows.map(rowToSupersession)
  }

  /** Supersession links where the given fact is the replacement (new) one. */
  listByNew(newFactId: string): Supersession[] {
    const rows = this.db
      .prepare('SELECT * FROM supersessions WHERE new_fact_id = ? ORDER BY created_at')
      .all(newFactId) as SupersessionRow[]
    return rows.map(rowToSupersession)
  }

  /** Purge supersession links touching a fact on either end (forget, §18.2). */
  deleteByFact(factId: string): void {
    this.db
      .prepare('DELETE FROM supersessions WHERE old_fact_id = ? OR new_fact_id = ?')
      .run(factId, factId)
  }

  /** All supersession links (used by bundle export, plan §19). Insertion order. */
  listAll(): Supersession[] {
    const rows = this.db
      .prepare('SELECT * FROM supersessions ORDER BY created_at')
      .all() as SupersessionRow[]
    return rows.map(rowToSupersession)
  }
}
