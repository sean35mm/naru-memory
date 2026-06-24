import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrate'

/** Tables/virtual tables the init migration must create (plan §11). */
const EXPECTED_TABLES = [
  'schema_migrations',
  'scopes',
  'episodes',
  'entities',
  'facts',
  'evidence',
  'edges',
  'supersessions',
  'embeddings',
  'index_state',
  'fact_vectors',
  'facts_fts',
  'entities_fts',
]

function objectNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

describe('runMigrations', () => {
  it('creates every canonical, derived, and FTS table', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const names = objectNames(db)
    for (const table of EXPECTED_TABLES) {
      expect(names.has(table), `expected table ${table} to exist`).toBe(true)
    }
    db.close()
  })

  it('records every migration in order exactly once and is idempotent on re-run', () => {
    const db = new Database(':memory:')

    runMigrations(db)
    const first = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as {
      version: string
      name: string
    }[]
    expect(first).toEqual([
      { version: '0001', name: 'init' },
      { version: '0002', name: 'vectors' },
    ])

    // Re-running must not re-apply or add duplicate bookkeeping rows.
    runMigrations(db)
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    expect(count.n).toBe(2)

    db.close()
  })
})
