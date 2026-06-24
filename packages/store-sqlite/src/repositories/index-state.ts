import type { IndexState, IndexStatus } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, stringifyRecord } from './json'

/** An `index_state` table row in snake_case column form. */
interface IndexStateRow {
  index_name: string
  index_version: string
  source_watermark: string | null
  source_hash: string | null
  status: string
  last_rebuilt_at: string | null
  error: string | null
  metadata_json: string
}

function rowToIndexState(row: IndexStateRow): IndexState {
  return {
    indexName: row.index_name,
    indexVersion: row.index_version,
    sourceWatermark: row.source_watermark,
    sourceHash: row.source_hash,
    status: row.status as IndexStatus,
    lastRebuiltAt: row.last_rebuilt_at,
    error: row.error,
    metadata: parseRecord(row.metadata_json),
  }
}

/** Persistence for derived-index freshness tracking (plan §11.10). */
export class IndexStateRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert-or-replace the freshness record for an index, keyed by `indexName`. */
  upsert(state: IndexState): IndexState {
    this.db
      .prepare(
        `INSERT INTO index_state
           (index_name, index_version, source_watermark, source_hash, status,
            last_rebuilt_at, error, metadata_json)
         VALUES
           (@indexName, @indexVersion, @sourceWatermark, @sourceHash, @status,
            @lastRebuiltAt, @error, @metadataJson)
         ON CONFLICT(index_name) DO UPDATE SET
           index_version = excluded.index_version,
           source_watermark = excluded.source_watermark,
           source_hash = excluded.source_hash,
           status = excluded.status,
           last_rebuilt_at = excluded.last_rebuilt_at,
           error = excluded.error,
           metadata_json = excluded.metadata_json`,
      )
      .run({
        indexName: state.indexName,
        indexVersion: state.indexVersion,
        sourceWatermark: state.sourceWatermark,
        sourceHash: state.sourceHash,
        status: state.status,
        lastRebuiltAt: state.lastRebuiltAt,
        error: state.error,
        metadataJson: stringifyRecord(state.metadata),
      })
    return state
  }

  get(indexName: string): IndexState | undefined {
    const row = this.db.prepare('SELECT * FROM index_state WHERE index_name = ?').get(indexName) as
      | IndexStateRow
      | undefined
    return row ? rowToIndexState(row) : undefined
  }

  /** List all tracked index freshness records. */
  list(): IndexState[] {
    const rows = this.db
      .prepare('SELECT * FROM index_state ORDER BY index_name')
      .all() as IndexStateRow[]
    return rows.map(rowToIndexState)
  }
}
