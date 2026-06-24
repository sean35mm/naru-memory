import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type Database from 'better-sqlite3'

/** Restrictive owner-only permission for a backup snapshot (plan §12.3). */
const BACKUP_FILE_MODE = 0o600

/** Result of a {@link backupDatabase} run (privacy-safe: counts/bytes only). */
export interface BackupResult {
  /** Absolute path the snapshot was written to. */
  path: string
  /** Snapshot file size in bytes. */
  bytes: number
}

/**
 * Write a consistent, standalone snapshot of `db` to `destPath` using SQLite's
 * `VACUUM INTO` (plan §20 M5 backup, §12.3).
 *
 * `VACUUM INTO` is the right primitive here:
 *  - It produces a fully self-contained, defragmented `.db` file (no WAL/SHM
 *    sidecars needed to open it).
 *  - It runs as a single read transaction against the live DB, so the snapshot
 *    is point-in-time CONSISTENT and the source DB is left UNCHANGED — this is a
 *    read-only operation with respect to the live database (no schema, no rows,
 *    no index_state touched).
 *
 * The destination must NOT already exist (`VACUUM INTO` refuses to overwrite),
 * which prevents clobbering an existing file. The parent directory is created
 * if missing, and the snapshot is chmod'd to owner-only (0600) best-effort, the
 * same posture as the live DB file. Returns the resolved path + byte size.
 *
 * Verifying the snapshot (opening it and comparing canonical counts) is the
 * caller's responsibility — see the core facade `backupTo`, which opens the
 * snapshot read-only and asserts identical canonical counts.
 */
export function backupDatabase(db: Database.Database, destPath: string): BackupResult {
  const abs = resolve(destPath)
  mkdirSync(dirname(abs), { recursive: true })

  // Parameterized so the path is bound as a value (no string interpolation into
  // SQL). VACUUM INTO refuses an existing target, so a pre-existing file throws.
  db.prepare('VACUUM INTO ?').run(abs)

  restrictPermissions(abs)
  const { size } = statSync(abs)
  return { path: abs, bytes: size }
}

/** Best-effort owner-only permissions on the snapshot file. */
function restrictPermissions(path: string): void {
  try {
    chmodSync(path, BACKUP_FILE_MODE)
  } catch {
    // Best-effort: some platforms ignore mode. The snapshot is still written.
  }
}
