import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@naru/store-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Safe backup via SQLite VACUUM INTO (plan §20 M5, §12.3).
 *
 * The snapshot must be a standalone .db with 0600 perms that opens and carries
 * identical canonical facts/scopes counts, and the live DB must be unaffected.
 * Tests use a temp dir — never a real user DB.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'naru-backup-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seed(naru: Naru): void {
  naru.addMemory({
    text: 'User prefers tabs over spaces',
    scope: { type: 'project', key: 'acme' },
  })
  naru.addMemory({
    text: 'User deploys on Fridays',
    scope: { type: 'user', key: 'sean' },
  })
}

describe('Naru.backupTo', () => {
  it('writes a standalone 0600 snapshot with identical facts/scopes counts', () => {
    const dbPath = join(dir, 'naru.db')
    const naru = Naru.open({ db: dbPath })
    try {
      seed(naru)
      const before = naru.status().counts

      const dest = join(dir, 'snapshot.db')
      const outcome = naru.backupTo(dest)

      // File exists, has bytes, and is reported verified.
      expect(existsSync(dest)).toBe(true)
      expect(outcome.bytes).toBeGreaterThan(0)
      expect(outcome.verified).toBe(true)
      expect(outcome.path).toBe(dest)

      // 0600 owner-only perms (mask the file-type bits).
      const mode = statSync(dest).mode & 0o777
      expect(mode).toBe(0o600)

      // VACUUM INTO produces a self-contained file: no WAL/SHM sidecars needed.
      expect(existsSync(`${dest}-wal`)).toBe(false)
      expect(existsSync(`${dest}-shm`)).toBe(false)

      // The snapshot opens independently and carries identical canonical counts.
      const restored = Store.open({ path: dest })
      try {
        const factCount = (
          restored.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }
        ).n
        const scopeCount = (
          restored.db.prepare('SELECT COUNT(*) AS n FROM scopes').get() as { n: number }
        ).n
        expect(factCount).toBe(before.facts)
        expect(scopeCount).toBe(before.scopes)
      } finally {
        restored.close()
      }
      // The outcome's verified counts mirror the source.
      expect(outcome.counts.facts).toBe(before.facts)
      expect(outcome.counts.scopes).toBe(before.scopes)
    } finally {
      naru.close()
    }
  })

  it('leaves the live DB unaffected (read-only) and remains writable after', () => {
    const dbPath = join(dir, 'naru.db')
    const naru = Naru.open({ db: dbPath })
    try {
      seed(naru)
      const before = naru.status().counts

      naru.backupTo(join(dir, 'snap.db'))

      // Live DB counts unchanged by the backup.
      const after = naru.status().counts
      expect(after).toEqual(before)

      // Still writable after backup (VACUUM INTO did not lock/mutate it).
      naru.addMemory({ text: 'Another fact', scope: { type: 'project', key: 'acme' } })
      expect(naru.status().counts.facts).toBe(before.facts + 1)
    } finally {
      naru.close()
    }
  })

  it('refuses to overwrite an existing snapshot file', () => {
    const dbPath = join(dir, 'naru.db')
    const naru = Naru.open({ db: dbPath })
    try {
      seed(naru)
      const dest = join(dir, 'once.db')
      naru.backupTo(dest)
      // A second backup to the same path must throw (VACUUM INTO refuses).
      expect(() => naru.backupTo(dest)).toThrow()
    } finally {
      naru.close()
    }
  })
})
