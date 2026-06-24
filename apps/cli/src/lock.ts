import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Embedded-writer file lock (plan §12.3 "Embedded fallback").
 *
 * When no live server owns a DB, the CLI/adapter writes in embedded mode. Two
 * embedded writers against one SQLite file would contend, so an embedded WRITE
 * first takes an exclusive `naru.lock` next to the DB. Reads need no lock — WAL
 * permits concurrent readers (plan §12.3); only the write path locks.
 *
 * The lock is a file created with the `wx` (exclusive create) flag so the OS
 * guarantees at most one holder; the holder's pid is written into it. A lock
 * whose pid is dead is STALE and reclaimed (a crashed writer must not wedge the
 * DB forever). The lock is always released in a `finally` by the caller.
 */

/** Lock-file basename suffix; the full name is derived from the DB file name. */
export const LOCK_FILE_SUFFIX = '.naru.lock'

/** Default time to wait for a contended lock before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000

/** Poll interval while waiting for a contended lock. */
const POLL_INTERVAL_MS = 50

/** Options for {@link acquireLock}. */
export interface AcquireLockOptions {
  /** Max time to wait for a held lock before throwing (ms). 0 = fail fast. */
  timeoutMs?: number
}

/** A held lock; call {@link release} (idempotent) when the write completes. */
export interface LockHandle {
  /** Absolute path of the lock file. */
  path: string
  /** Remove the lock file. Safe to call more than once. */
  release(): void
}

/**
 * Absolute path of the lock file for a DB path.
 *
 * Mirrors the discovery file: it sits in the DB's directory so it travels with
 * the store, and its name is DERIVED FROM THE DB FILE NAME so two DBs colocated
 * in one directory get distinct locks (and stay paired with their per-DB
 * discovery file). `:memory:` (no real directory) resolves under the cwd so
 * tests on a temp DB stay correct and a user dir is never touched.
 */
export function lockFilePath(dbPath: string): string {
  if (dbPath === ':memory:') {
    return join(process.cwd(), `memory${LOCK_FILE_SUFFIX}`)
  }
  return join(dirname(dbPath), `${basename(dbPath)}${LOCK_FILE_SUFFIX}`)
}

/** Whether a pid is currently alive (POSIX `kill(pid, 0)` probe). */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM => the process exists but is owned by another user (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Read the pid recorded in a lock file, or null if missing/unreadable. */
function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

/** Create the lock file exclusively and write our pid; throws EEXIST if held. */
function createLock(path: string): LockHandle {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  let released = false
  return {
    path,
    release(): void {
      if (released) {
        return
      }
      released = true
      rmSync(path, { force: true })
    },
  }
}

/**
 * Acquire the embedded-writer lock for `dbPath`.
 *
 * Uses an exclusive-create file as the mutex. If the lock is already held by a
 * LIVE process, waits up to `timeoutMs` (polling) for it to release; a lock held
 * by a DEAD process is reclaimed immediately (stale). Throws if the timeout
 * elapses while a live holder keeps it. Always pair with `release()` in a
 * `finally`.
 */
export function acquireLock(dbPath: string, options: AcquireLockOptions = {}): LockHandle {
  const path = lockFilePath(dbPath)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  let reclaim = 0
  for (;;) {
    try {
      return createLock(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err
      }
      // Lock exists. If its owner is dead, reclaim it; otherwise wait/timeout.
      const pid = readLockPid(path)
      if (pid === null || !isAlive(pid)) {
        // Reclaim ATOMICALLY: rename the stale lock aside (only one racer wins
        // the rename) instead of a blind delete-then-create. A blind delete
        // lets a slower racer's rmSync delete the lock a faster racer just
        // created with `wx`, leaving two holders. After renaming, re-verify the
        // moved file still holds the dead pid we saw before discarding it.
        const aside = `${path}.${process.pid}.${reclaim++}.stale`
        try {
          renameSync(path, aside)
        } catch {
          // Lost the rename race (another reclaimer took it / it vanished); the
          // winner now (re)holds the lock, so loop and contend for it normally.
          continue
        }
        const asidePid = readLockPid(aside)
        if (asidePid !== null && isAlive(asidePid)) {
          // It went live between our read and rename: restore and treat as held.
          try {
            renameSync(aside, path)
          } catch {
            rmSync(aside, { force: true })
          }
          continue
        }
        rmSync(aside, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `another naru process (pid ${pid}) holds the write lock at ${path}; try again or use the running server`,
        )
      }
      // Busy-wait briefly; embedded writes are short and this path is rare.
      const until = Math.min(Date.now() + POLL_INTERVAL_MS, deadline)
      while (Date.now() < until) {
        // spin
      }
    }
  }
}
