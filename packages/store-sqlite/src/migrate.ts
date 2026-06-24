import { nowIso, sha256Hex } from '@naru/schema'
import type Database from 'better-sqlite3'
import { MIGRATIONS, latestSchemaVersion } from './migrations'

/** SQL that guarantees the migrations bookkeeping table exists. */
const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

interface AppliedRow {
  version: string
}

/**
 * Apply all pending migrations, in version order, idempotently (plan §24.4).
 *
 * Ensures `schema_migrations` exists, reads applied versions, and for each
 * pending migration runs its SQL and records `{version, name, checksum, applied_at}`
 * inside a single transaction so a failure leaves no partial schema. Re-running
 * is a no-op and adds no duplicate `schema_migrations` rows.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(ENSURE_MIGRATIONS_TABLE)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as AppliedRow[]).map(
      (row) => row.version,
    ),
  )

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, sha256Hex(migration.sql), nowIso())
    })
    apply()
  }
}

/**
 * Validate that a DB is already migrated to the latest schema WITHOUT writing
 * anything (plan §12.3 read-only admin ops: export/backup/check must not mutate
 * the live DB or run migrations on a second connection behind a live server).
 *
 * Purely read-only: queries `sqlite_master` and `schema_migrations` only — it
 * never issues `CREATE TABLE IF NOT EXISTS`, pragmas, or migration SQL. Throws a
 * clear, actionable error when the DB is uninitialized (no `schema_migrations`
 * table) or behind the latest schema, so a read-only caller fails fast instead
 * of silently triggering a write.
 */
export function assertSchemaCurrent(db: Database.Database): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined
  if (!table) {
    throw new Error(
      'database is not initialized (no schema_migrations table); run a write op or `naru init` first before a read-only operation',
    )
  }

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as AppliedRow[]).map(
      (row) => row.version,
    ),
  )
  const latest = latestSchemaVersion()
  if (!applied.has(latest)) {
    throw new Error(
      `database schema is behind (latest known migration "${latest}" not applied); run a write op or \`naru init\` to migrate before a read-only operation`,
    )
  }
}
