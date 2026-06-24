import type { Episode, RetentionMode, SourceType } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, stringifyRecord } from './json'

/** An `episodes` table row in snake_case column form. */
interface EpisodeRow {
  id: string
  scope_id: string
  source_type: string
  source_ref: string | null
  source_hash: string
  hmac_hash: string | null
  retention_mode: string
  redacted_text: string | null
  metadata_json: string
  observed_at: string
  created_at: string
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    scopeId: row.scope_id,
    sourceType: row.source_type as SourceType,
    sourceRef: row.source_ref,
    sourceHash: row.source_hash,
    hmacHash: row.hmac_hash,
    retentionMode: row.retention_mode as RetentionMode,
    redactedText: row.redacted_text,
    metadata: parseRecord(row.metadata_json),
    observedAt: row.observed_at,
    createdAt: row.created_at,
  }
}

/** Persistence for captured source episodes (plan §11.3). */
export class EpisodesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert a fully-formed episode (caller supplies id/hashes/timestamps). */
  insert(episode: Episode): Episode {
    this.db
      .prepare(
        `INSERT INTO episodes
           (id, scope_id, source_type, source_ref, source_hash, hmac_hash,
            retention_mode, redacted_text, metadata_json, observed_at, created_at)
         VALUES
           (@id, @scopeId, @sourceType, @sourceRef, @sourceHash, @hmacHash,
            @retentionMode, @redactedText, @metadataJson, @observedAt, @createdAt)`,
      )
      .run({
        id: episode.id,
        scopeId: episode.scopeId,
        sourceType: episode.sourceType,
        sourceRef: episode.sourceRef,
        sourceHash: episode.sourceHash,
        hmacHash: episode.hmacHash,
        retentionMode: episode.retentionMode,
        redactedText: episode.redactedText,
        metadataJson: stringifyRecord(episode.metadata),
        observedAt: episode.observedAt,
        createdAt: episode.createdAt,
      })
    return episode
  }

  getById(id: string): Episode | undefined {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as
      | EpisodeRow
      | undefined
    return row ? rowToEpisode(row) : undefined
  }

  /** Look up an episode by its `(scope, source_hash)` dedupe key (plan §13.1). */
  getBySourceHash(scopeId: string, sourceHash: string): Episode | undefined {
    const row = this.db
      .prepare('SELECT * FROM episodes WHERE scope_id = ? AND source_hash = ?')
      .get(scopeId, sourceHash) as EpisodeRow | undefined
    return row ? rowToEpisode(row) : undefined
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM episodes WHERE id = ?').run(id)
  }

  /** All episodes (used by bundle export, plan §19). Insertion order. */
  listAll(): Episode[] {
    const rows = this.db.prepare('SELECT * FROM episodes ORDER BY created_at').all() as EpisodeRow[]
    return rows.map(rowToEpisode)
  }
}
