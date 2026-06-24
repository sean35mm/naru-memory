import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Server discovery + ownership contract (plan §12.3, §15.3).
 *
 * A single local server owns each DB file. On start it atomically claims an
 * ownership lock keyed to the DB file (see {@link acquireServerOwnership}) and
 * publishes a discovery file NEXT TO the DB recording how to reach it: host,
 * port, auth token, and the owning pid. Clients (CLI/adapter) read this file to
 * decide whether to proxy writes to a live server or fall back to embedded
 * mode. The file is the storage-side view of the same mechanism as the §15.3
 * auth token on the transport side.
 *
 * The file is written with mode `0600` because it carries the bearer token.
 * Readers MUST treat a file whose `pid` is not alive as STALE and ignore it,
 * so a crashed server never blocks a new one or hands out a dead address.
 */

/**
 * Discovery file basename for a DB. Derived from the DB file's own name (not
 * just its directory) so two DBs colocated in one directory (e.g. `a.db` and
 * `b.db`) map to DISTINCT discovery files — one server per DB file, never per
 * directory (plan §12.3 "one server per DB"). For `:memory:` there is no file
 * name, so a fixed sentinel is used under the cwd.
 */
export function serverFileName(dbPath: string): string {
  if (dbPath === ':memory:') {
    return 'memory.naru-server.json'
  }
  return `${basename(dbPath)}.naru-server.json`
}

/** Parsed contents of a discovery file. */
export interface ServerFile {
  /** Loopback host the server is bound to (e.g. `127.0.0.1`). */
  host: string
  /** TCP port the server is listening on (resolved, never `0`). */
  port: number
  /** Bearer auth token required on every non-health request (plan §15.3). */
  token: string
  /** OS process id of the owning server, used for liveness/staleness checks. */
  pid: number
}

/** Inputs for {@link writeServerFile}; `dbPath` locates the file. */
export interface WriteServerFileInput extends ServerFile {
  /** Canonical DB path whose directory hosts the discovery file. */
  dbPath: string
}

/**
 * Absolute path of the discovery file for a given DB path.
 *
 * The file lives in the same directory as the DB so it travels with the store,
 * and its name is derived from the DB file name so one server maps to one DB
 * file (not one directory). `:memory:` (and any path without a real directory)
 * resolves relative to the current working directory, which keeps tests that
 * use an on-disk temp DB correct while never touching a user dir.
 */
export function serverFilePath(dbPath: string): string {
  const dir = dbPath === ':memory:' ? process.cwd() : dirname(dbPath)
  return join(dir, serverFileName(dbPath))
}

/**
 * Whether a process id is currently alive.
 *
 * Uses the POSIX `kill(pid, 0)` probe: signal `0` performs the permission/
 * existence check without delivering a signal. A missing process throws
 * `ESRCH`; `EPERM` means the process exists but is owned by another user
 * (still alive). Any other error is treated as not-alive (fail-safe).
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Write the discovery file for `dbPath` with restrictive `0600` permissions,
 * atomically and with deterministic mode.
 *
 * Writes to a sibling temp file created with `0600` then `rename()`s it over the
 * target. `rename` is atomic, so concurrent readers never observe a torn file,
 * and the published file always carries the temp file's `0600` mode regardless
 * of whether a (possibly looser-permissioned) stale file already existed — the
 * `mode` option of `writeFileSync` alone is NOT applied when overwriting an
 * existing file, which would leave a stale `0644` token world-readable.
 */
export function writeServerFile(input: WriteServerFileInput): void {
  const { dbPath, ...record } = input
  const target = serverFilePath(dbPath)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Read and parse the discovery file for `dbPath`.
 *
 * Returns `null` when the file is absent, unparseable, structurally invalid,
 * or STALE (its `pid` is not alive). A stale file is treated as if it does not
 * exist so a reader never trusts a dead server's address.
 */
export function readServerFile(dbPath: string): ServerFile | null {
  return parseServerFileAt(serverFilePath(dbPath))
}

/** Parse + liveness-check a discovery file at an absolute path. */
function parseServerFileAt(path: string): ServerFile | null {
  if (!existsSync(path)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { host, port, token, pid } = parsed as Record<string, unknown>
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof token !== 'string' ||
    typeof pid !== 'number'
  ) {
    return null
  }
  if (!isAlive(pid)) {
    return null
  }
  return { host, port, token, pid }
}

/**
 * Remove the discovery file for `dbPath` ONLY if it is still owned by the
 * caller (matching `pid` and `token`).
 *
 * Ownership is checked so a server never deletes a discovery file it does not
 * own: a different DB's server in the same directory (impossible now that the
 * name is DB-file-derived, but defensive), or — combined with any future
 * ownership race — a live server's file published by someone else. A missing
 * file is not an error.
 */
export function removeServerFile(dbPath: string, owner?: { pid: number; token: string }): void {
  const path = serverFilePath(dbPath)
  if (owner) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // Absent or unparseable: nothing of ours to remove.
      return
    }
    const rec = parsed as Record<string, unknown>
    if (rec.pid !== owner.pid || rec.token !== owner.token) {
      return
    }
  }
  rmSync(path, { force: true })
}

/** A held server-ownership claim over a DB; release on shutdown. */
export interface ServerOwnership {
  /** Absolute path of the ownership lock file. */
  path: string
  /** Release the ownership lock (idempotent). */
  release(): void
}

/** Ownership lock basename for a DB, paired with the discovery file name. */
function ownershipLockPath(dbPath: string): string {
  const dir = dbPath === ':memory:' ? process.cwd() : dirname(dbPath)
  const base = dbPath === ':memory:' ? 'memory' : basename(dbPath)
  return join(dir, `${base}.naru-server.lock`)
}

/** Read the pid recorded in an ownership lock file, or null if unreadable. */
function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

/**
 * Atomically claim sole-server ownership of `dbPath` before opening the store
 * or binding (plan §12.3 single logical writer, §15.3 one-server-per-DB).
 *
 * Uses an exclusive-create lock file (`openSync(..., 'wx')`) keyed to the DB
 * file: the OS guarantees exactly one creator, collapsing the read-then-write
 * TOCTOU where two `createServer()` calls on the same DB both passed a
 * non-atomic discovery-file check and both started. On `EEXIST`:
 *
 * - if the recorded pid is LIVE -> throw (a server already owns this DB);
 * - if the pid is DEAD/unreadable -> the lock is stale; reclaim it atomically
 *   by renaming it aside (only one racer wins the rename), re-verifying the pid
 *   is still the dead one, unlinking it, and retrying the exclusive create.
 *
 * Returns a handle whose `release()` removes the lock; the caller MUST release
 * it on shutdown (and on any startup failure after acquisition).
 */
export function acquireServerOwnership(dbPath: string): ServerOwnership {
  const path = ownershipLockPath(dbPath)
  for (let attempt = 0; attempt < 50; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err
      }
      const pid = readLockPid(path)
      if (pid !== null && isAlive(pid)) {
        throw new Error(
          `A live Naru server already owns this DB (pid ${pid}). Refusing to start a second.`,
        )
      }
      // Stale lock: reclaim atomically. Rename aside (only one racer succeeds),
      // confirm it still holds the dead pid we saw, then unlink and retry.
      const aside = `${path}.${process.pid}.${attempt}.stale`
      try {
        renameSync(path, aside)
      } catch {
        // Lost the rename race (another reclaimer took it, or it vanished);
        // loop and re-read.
        continue
      }
      const asidePid = readLockPid(aside)
      if (asidePid !== null && isAlive(asidePid)) {
        // It went live between read and rename — put it back and refuse.
        try {
          renameSync(aside, path)
        } catch {
          rmSync(aside, { force: true })
        }
        throw new Error(
          `A live Naru server already owns this DB (pid ${asidePid}). Refusing to start a second.`,
        )
      }
      rmSync(aside, { force: true })
      continue
    }
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
        // Only remove the lock if it is still ours.
        if (readLockPid(path) === process.pid) {
          try {
            unlinkSync(path)
          } catch {
            // already gone
          }
        }
      },
    }
  }
  throw new Error(`could not acquire server ownership for ${dbPath} after repeated stale reclaims`)
}
