import { existsSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppRouter } from '@naru/api'
import { TRPCClientError, createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterEach, describe, expect, it } from 'vitest'
import { serverFilePath } from './discovery'
import { type ServerHandle, createServer } from './server'

/** Build a typed client bound to `url` with an optional bearer token. */
function clientFor(url: string, token?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    ],
  })
}

describe('@naru/server createServer (plan §15.3, §12.3)', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  /** Open a fresh on-disk DB under a temp dir; never a real user DB. */
  function freshDb(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'naru-server-test-'))
    return join(tmpDir, 'naru.db')
  }

  it('authed client can memory.add then memory.search round-trip', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const client = clientFor(handle.url, handle.token)
      const scope = { type: 'project' as const, key: 'app' }
      const fact = await client.memory.add.mutate({
        text: 'The API rate limit is 100 requests per minute.',
        scope,
      })
      expect(fact.id).toMatch(/^fact_/)

      const results = await client.memory.search.query({ query: 'rate limit', scope })
      expect(results.some((r) => r.factId === fact.id)).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('a client with no or wrong token gets UNAUTHORIZED', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const noToken = clientFor(handle.url)
      await expect(noToken.scope.list.query()).rejects.toMatchObject({
        data: { code: 'UNAUTHORIZED' },
      })

      const wrongToken = clientFor(handle.url, 'deadbeef')
      const err = await wrongToken.scope.list.query().catch((e) => e)
      expect(err).toBeInstanceOf(TRPCClientError)
      expect((err as TRPCClientError<AppRouter>).data?.code).toBe('UNAUTHORIZED')
    } finally {
      await handle.close()
    }
  })

  it('GET /health returns 200 with no token (plain fetch)', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const res = await fetch(`${handle.url}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await handle.close()
    }
  })

  it('a POST with a cross-origin Origin header is rejected with 403', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const res = await fetch(`${handle.url}/scope.list`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          origin: 'http://evil.example',
          'content-type': 'application/json',
        },
      })
      expect(res.status).toBe(403)
    } finally {
      await handle.close()
    }
  })

  it('writes the discovery file while running and removes it on close', async () => {
    const dbPath = freshDb()
    const handle = await createServer({ db: dbPath, port: 0 })
    const filePath = serverFilePath(dbPath)
    expect(existsSync(filePath)).toBe(true)
    await handle.close()
    expect(existsSync(filePath)).toBe(false)
  })

  it('binds 127.0.0.1 only', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      expect(handle.host).toBe('127.0.0.1')
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await handle.close()
    }
  })

  it('refuses to start a second live server for the same DB', async () => {
    const dbPath = freshDb()
    let first: ServerHandle | undefined
    try {
      first = await createServer({ db: dbPath, port: 0 })
      await expect(createServer({ db: dbPath, port: 0 })).rejects.toThrow(/already owns this DB/)
    } finally {
      if (first) {
        await first.close()
      }
    }
  })

  it('two servers racing on the same DB cannot both start (atomic ownership §12.3)', async () => {
    const dbPath = freshDb()
    const results = await Promise.allSettled([
      createServer({ db: dbPath, port: 0 }),
      createServer({ db: dbPath, port: 0 }),
    ])
    const started = results.filter((r) => r.status === 'fulfilled')
    try {
      // Exactly one wins; the other is rejected by the atomic ownership lock.
      expect(started.length).toBe(1)
      expect(results.some((r) => r.status === 'rejected')).toBe(true)
    } finally {
      for (const r of started) {
        if (r.status === 'fulfilled') {
          await r.value.close()
        }
      }
    }
  })

  it('publishes the discovery file with 0600 perms even over a loose stale file', async () => {
    const dbPath = freshDb()
    // Seed a pre-existing, world-readable file at the discovery path.
    writeFileSync(serverFilePath(dbPath), '{"stale":true}', { mode: 0o644 })
    const handle = await createServer({ db: dbPath, port: 0 })
    try {
      const mode = statSync(serverFilePath(dbPath)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      await handle.close()
    }
  })

  it('a request with no Host header is rejected with 403 (rebinding defense §15.3)', async () => {
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const status = await rawStatusLine(handle.port, [
        'POST /scope.list HTTP/1.0',
        `authorization: Bearer ${handle.token}`,
        'content-type: application/json',
        // intentionally NO Host header
      ])
      expect(status).toBe(403)
    } finally {
      await handle.close()
    }
  })
})

/** Send a raw HTTP request (no auto Host) and resolve its status code. */
function rawStatusLine(port: number, requestLines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLines.join('\r\n')}\r\n\r\n`)
    })
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
    })
    socket.on('end', () => {
      const match = buf.match(/^HTTP\/\d\.\d (\d{3})/)
      if (!match || match[1] === undefined) {
        reject(new Error(`no status line in response: ${buf.slice(0, 80)}`))
        return
      }
      resolve(Number.parseInt(match[1], 10))
    })
    socket.on('error', reject)
  })
}
