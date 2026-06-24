import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

/** Options for opening the canonical SQLite store. */
export interface OpenDatabaseOptions {
  /** Filesystem path to the database file, or ':memory:' for an in-memory DB. */
  path: string
  /** Open read-only (no writes, no migrations applied). */
  readonly?: boolean
}

/** Restrictive owner-only permission for the local memory DB (plan §12.3). */
const DB_FILE_MODE = 0o600

/**
 * Open the canonical SQLite database with Naru's operational settings (plan §12.3):
 * WAL journaling, a busy timeout, foreign keys on, and NORMAL synchronous.
 *
 * For on-disk databases the parent directory is created if missing and the DB
 * file (plus its `-wal`/`-shm` sidecars) is chmod'd to owner-only — best effort,
 * since not every platform honors it.
 */
export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  const { path, readonly = false } = options
  const isMemory = path === ':memory:'

  // For a writable on-disk open, ensure the parent dir exists so the DB file can
  // be created. A read-only open must NOT create directories or the file: a
  // missing DB should fail fast (the caller asked to read, not initialize).
  if (!isMemory && !readonly) {
    mkdirSync(dirname(path), { recursive: true })
  }

  let db: Database.Database
  try {
    db = new Database(path, { readonly, fileMustExist: readonly && !isMemory })
  } catch (cause) {
    // A read-only open of a missing DB fails here (fileMustExist). Surface a
    // clear, actionable message instead of the raw driver "unable to open"
    // string: a read-only op must not initialize the DB (plan §12.3).
    if (readonly && !isMemory) {
      throw new Error(
        `database not found at ${path}; a read-only operation cannot initialize it — run a write op or \`naru init\` first`,
        { cause },
      )
    }
    throw cause
  }

  // Operational pragmas (plan §12.3). WAL allows concurrent readers; a busy
  // timeout absorbs short write contention; foreign keys enforce referential
  // integrity; NORMAL synchronous is the recommended WAL durability tradeoff.
  //
  // Setting `journal_mode = WAL` and `synchronous` are WRITE operations on the DB
  // header, so they are skipped on a READ-ONLY connection (a read-only op joins
  // the journal mode the writable owner already set, e.g. WAL). `busy_timeout`
  // and `foreign_keys` are connection-local and safe read-only.
  if (!isMemory && !readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  if (!isMemory && !readonly) {
    restrictPermissions(path)
  }

  return db
}

/** Best-effort owner-only permissions on the DB file and its WAL/SHM sidecars. */
function restrictPermissions(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(target, DB_FILE_MODE)
    } catch {
      // Best-effort: sidecars may not exist yet and some platforms ignore mode.
    }
  }
}
