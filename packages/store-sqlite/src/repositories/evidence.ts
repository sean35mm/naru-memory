import type { Evidence } from '@naru/schema'
import type Database from 'better-sqlite3'

/** An `evidence` table row in snake_case column form. */
interface EvidenceRow {
  id: string
  fact_id: string
  episode_id: string
  span_start: number | null
  span_end: number | null
  redacted_quote: string | null
  quote_hash: string | null
  extractor_name: string
  extractor_version: string
  created_at: string
}

function rowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    factId: row.fact_id,
    episodeId: row.episode_id,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    redactedQuote: row.redacted_quote,
    quoteHash: row.quote_hash,
    extractorName: row.extractor_name,
    extractorVersion: row.extractor_version,
    createdAt: row.created_at,
  }
}

/** Persistence for fact->episode evidence links (plan §11.6). */
export class EvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  insert(evidence: Evidence): Evidence {
    this.db
      .prepare(
        `INSERT INTO evidence
           (id, fact_id, episode_id, span_start, span_end, redacted_quote, quote_hash,
            extractor_name, extractor_version, created_at)
         VALUES
           (@id, @factId, @episodeId, @spanStart, @spanEnd, @redactedQuote, @quoteHash,
            @extractorName, @extractorVersion, @createdAt)`,
      )
      .run({
        id: evidence.id,
        factId: evidence.factId,
        episodeId: evidence.episodeId,
        spanStart: evidence.spanStart,
        spanEnd: evidence.spanEnd,
        redactedQuote: evidence.redactedQuote,
        quoteHash: evidence.quoteHash,
        extractorName: evidence.extractorName,
        extractorVersion: evidence.extractorVersion,
        createdAt: evidence.createdAt,
      })
    return evidence
  }

  listByFact(factId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE fact_id = ? ORDER BY created_at')
      .all(factId) as EvidenceRow[]
    return rows.map(rowToEvidence)
  }

  /** Distinct episode ids referenced by a fact's evidence (forget, §18.2). */
  episodeIdsByFact(factId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT episode_id FROM evidence WHERE fact_id = ?')
      .all(factId) as { episode_id: string }[]
    return rows.map((r) => r.episode_id)
  }

  /** Whether any evidence row still references the given episode (forget, §18.2). */
  hasEpisode(episodeId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM evidence WHERE episode_id = ? LIMIT 1')
      .get(episodeId) as { hit: number } | undefined
    return row !== undefined
  }

  /** Purge all evidence for a fact (used by destructive forget, plan §18.2). */
  deleteByFact(factId: string): void {
    this.db.prepare('DELETE FROM evidence WHERE fact_id = ?').run(factId)
  }

  /** All evidence rows (used by bundle export, plan §19). Insertion order. */
  listAll(): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence ORDER BY created_at')
      .all() as EvidenceRow[]
    return rows.map(rowToEvidence)
  }
}
