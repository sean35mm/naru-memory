import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Naru } from '@naru/core'
import { createServer, readServerFile } from '@naru/server'
import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddedClient } from './client'
import { acquireLock, lockFilePath } from './lock'
import { RemoteClient } from './remote-client'
import { resolveClient } from './resolve'

let tmpDir: string | undefined

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

/** Fresh on-disk DB under a temp dir; never a real user DB. */
function freshDb(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'naru-cli-server-mode-'))
  return join(tmpDir, 'naru.db')
}

describe('embedded path (plan §12.3 embedded fallback)', () => {
  it('add + search round-trips via EmbeddedClient against a tmp DB', async () => {
    const dbPath = freshDb()
    const client = new EmbeddedClient(Naru.open({ db: dbPath }), dbPath)
    try {
      const scope = { type: 'user' as const, key: 'alice' }
      const fact = await client.addMemory({ text: 'User prefers dark mode', scope })
      expect(fact.id).toMatch(/^fact_/)

      const results = await client.search({ query: 'dark', scope })
      expect(results.some((r) => /dark mode/i.test(r.statement))).toBe(true)

      const status = await client.status()
      expect(status.server.mode).toBe('embedded')
    } finally {
      await client.close()
    }
  })

  it('resolveClient picks EmbeddedClient when no live server owns the DB', async () => {
    const dbPath = freshDb()
    const client = resolveClient({ db: dbPath })
    try {
      expect(client).toBeInstanceOf(EmbeddedClient)
    } finally {
      await client.close()
    }
  })
})

describe('remote path (plan §12.3 single logical writer, §15)', () => {
  it('resolveClient proxies to a live server and data lands in its store', async () => {
    const dbPath = freshDb()
    const handle = await createServer({ db: dbPath, port: 0 })
    try {
      // A live server published its discovery file next to the DB.
      expect(readServerFile(dbPath)).not.toBeNull()

      const client = resolveClient({ db: dbPath })
      expect(client).toBeInstanceOf(RemoteClient)

      const scope = { type: 'project' as const, key: 'app' }
      const fact = await client.addMemory({
        text: 'The API rate limit is 100 requests per minute',
        scope,
      })
      expect(fact.id).toMatch(/^fact_/)
      await client.close()

      // The write must have landed in the SERVER's store, not a private
      // embedded copy: search the same server transport for it.
      const remote = resolveClient({ db: dbPath })
      try {
        const results = await remote.search({ query: 'rate limit', scope })
        expect(results.some((r) => r.factId === fact.id)).toBe(true)
        const status = await remote.status()
        expect(status.server.mode).toBe('remote')
        expect(status.server.url).toBe(handle.url)
      } finally {
        await remote.close()
      }
    } finally {
      await handle.close()
    }
  })

  it('falls back to embedded once the server is gone (stale discovery file)', async () => {
    const dbPath = freshDb()
    const handle = await createServer({ db: dbPath, port: 0 })
    await handle.close()
    // close() removed the discovery file, so resolution must go embedded again.
    const client = resolveClient({ db: dbPath })
    try {
      expect(client).toBeInstanceOf(EmbeddedClient)
    } finally {
      await client.close()
    }
  })
})

describe('embedded write lock (plan §12.3)', () => {
  it('a second writer fails fast while the first holds the lock', () => {
    const dbPath = freshDb()
    const held = acquireLock(dbPath)
    try {
      // timeoutMs:0 => fail fast rather than wait for a live holder.
      expect(() => acquireLock(dbPath, { timeoutMs: 0 })).toThrow(/holds the write lock/)
    } finally {
      held.release()
    }
  })

  it('the lock can be reacquired after release', () => {
    const dbPath = freshDb()
    const first = acquireLock(dbPath)
    first.release()
    const second = acquireLock(dbPath, { timeoutMs: 0 })
    second.release()
    // release() is idempotent.
    expect(() => second.release()).not.toThrow()
  })

  it('a lock left by a dead process is reclaimed', () => {
    const dbPath = freshDb()
    // Seed a stale lock pointing at a pid that cannot be alive.
    writeFileSync(lockFilePath(dbPath), '999999999', { mode: 0o600 })
    const lock = acquireLock(dbPath, { timeoutMs: 0 })
    try {
      expect(lock.path).toBe(lockFilePath(dbPath))
    } finally {
      lock.release()
    }
  })
})
