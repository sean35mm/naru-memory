import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NO_SERVER_MESSAGE,
  NoServerError,
  type RemoteClientOptions,
  type ResolvedServer,
  createRemoteClient,
  isNoServerError,
} from './remote'

/**
 * Remote-only client resolution + transport (plan §17, Bun-safe).
 *
 * Verifies server resolution priority (explicit -> env -> discovery file), the
 * friendly no-server condition, lazy connection, and the Bearer header — all
 * with NO real network: a fake tRPC client factory captures the resolved server
 * (and the default factory's header function is exercised against a stubbed
 * global `fetch`).
 */

/**
 * A fake tRPC client whose methods are vi mocks, plus a record of the
 * {@link ResolvedServer} it was built from. Lets a test assert what the client
 * resolved to and that methods proxy through — without any HTTP.
 */
function fakeClientFactory() {
  const calls: { resolved: ResolvedServer; built: number } = {
    resolved: undefined as unknown as ResolvedServer,
    built: 0,
  }
  const search = vi.fn().mockResolvedValue([])
  const factGet = vi.fn().mockResolvedValue({ fact: {}, evidence: [] })
  const factory = (resolved: ResolvedServer) => {
    calls.resolved = resolved
    calls.built += 1
    return {
      memory: { search: { query: search } },
      fact: { get: { query: factGet } },
    } as never
  }
  return { factory, calls, search, factGet }
}

/** Minimal options builder with a no-server default discovery + empty env. */
function opts(overrides: Partial<RemoteClientOptions> = {}): RemoteClientOptions {
  return {
    env: {},
    readDiscoveryFile: () => null,
    ...overrides,
  }
}

describe('createRemoteClient — server resolution (plan §17)', () => {
  it('resolves explicit { url, token } at highest priority', async () => {
    const { factory, calls } = fakeClientFactory()
    const client = createRemoteClient(
      opts({
        server: { url: 'http://127.0.0.1:5000/', token: 'explicit-tok' },
        // env + discovery also present, but explicit must win.
        env: { NARU_SERVER_URL: 'http://10.0.0.1:9999', NARU_SERVER_TOKEN: 'env-tok' },
        readDiscoveryFile: () => ({ host: '1.2.3.4', port: 1, token: 'disc', pid: 1 }),
        createClient: factory,
      }),
    )

    const resolved = client.resolveServer()
    expect(resolved.source).toBe('explicit')
    // Trailing slash normalized away so tRPC appends procedure paths cleanly.
    expect(resolved.baseUrl).toBe('http://127.0.0.1:5000')
    expect(resolved.token).toBe('explicit-tok')

    // Lazy: building the client happens on first call, with the resolved server.
    await client.search({ query: 'x' } as never)
    expect(calls.built).toBe(1)
    expect(calls.resolved.token).toBe('explicit-tok')
  })

  it('resolves from NARU_SERVER_URL + NARU_SERVER_TOKEN when no explicit opts', () => {
    const { factory } = fakeClientFactory()
    const client = createRemoteClient(
      opts({
        env: { NARU_SERVER_URL: 'http://localhost:7000', NARU_SERVER_TOKEN: 'env-tok' },
        readDiscoveryFile: () => ({ host: '1.2.3.4', port: 1, token: 'disc', pid: 1 }),
        createClient: factory,
      }),
    )
    const resolved = client.resolveServer()
    expect(resolved.source).toBe('env')
    expect(resolved.baseUrl).toBe('http://localhost:7000')
    expect(resolved.token).toBe('env-tok')
  })

  it('falls back to the discovery file when no explicit opts / env', () => {
    const { factory } = fakeClientFactory()
    const client = createRemoteClient(
      opts({
        readDiscoveryFile: () => ({ host: '127.0.0.1', port: 4319, token: 'disc-tok', pid: 4242 }),
        createClient: factory,
      }),
    )
    const resolved = client.resolveServer()
    expect(resolved.source).toBe('discovery')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:4319')
    expect(resolved.token).toBe('disc-tok')
  })

  it('reads + parses a real discovery file from a temp dir (default reader)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naru-remote-'))
    const dbPath = join(dir, 'naru.db')
    try {
      writeFileSync(
        `${dbPath}.naru-server.json`,
        JSON.stringify({ host: '127.0.0.1', port: 5151, token: 'file-tok', pid: 9999 }),
      )
      // No env, no explicit, default fs-backed reader -> reads the temp file.
      const client = createRemoteClient({ dbPath, env: {} })
      const resolved = client.resolveServer()
      expect(resolved.source).toBe('discovery')
      expect(resolved.baseUrl).toBe('http://127.0.0.1:5151')
      expect(resolved.token).toBe('file-tok')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('memoizes resolution + the built client across calls', async () => {
    const { factory, calls } = fakeClientFactory()
    let reads = 0
    const client = createRemoteClient(
      opts({
        readDiscoveryFile: () => {
          reads += 1
          return { host: '127.0.0.1', port: 1, token: 't', pid: 1 }
        },
        createClient: factory,
      }),
    )
    await client.search({ query: 'a' } as never)
    await client.search({ query: 'b' } as never)
    // Resolved once, client built once, discovery read once.
    expect(reads).toBe(1)
    expect(calls.built).toBe(1)
  })
})

describe('createRemoteClient — no-server condition (plan §17)', () => {
  it('throws a typed NoServerError with the friendly message when nothing resolves', async () => {
    const client = createRemoteClient(opts())
    // resolveServer surfaces it synchronously...
    expect(() => client.resolveServer()).toThrow(NoServerError)
    // ...and every method rejects with it (never crashes the plugin).
    await expect(client.search({ query: 'x' } as never)).rejects.toThrowError(NoServerError)
    await expect(client.status()).rejects.toSatisfy(isNoServerError)

    try {
      client.resolveServer()
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isNoServerError(err)).toBe(true)
      expect((err as Error).message).toBe(NO_SERVER_MESSAGE)
      expect((err as NoServerError).code).toBe('NARU_NO_SERVER')
    }
  })

  it('treats a blank explicit url/token as unresolved', () => {
    const client = createRemoteClient(opts({ server: { url: '   ', token: '' } }))
    expect(() => client.resolveServer()).toThrow(NoServerError)
  })

  it('treats blank env values as unresolved', () => {
    const client = createRemoteClient(
      opts({ env: { NARU_SERVER_URL: '', NARU_SERVER_TOKEN: 'tok' } }),
    )
    expect(() => client.resolveServer()).toThrow(NoServerError)
  })
})

describe('createRemoteClient — Bearer header (plan §15.3)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('builds an `authorization: Bearer <token>` header on real requests (default factory)', async () => {
    // Capture the outgoing request the default httpBatchLink factory produces,
    // proving the Bearer header is constructed from the resolved token — without
    // a real server (the stub returns a valid tRPC batch envelope).
    const seen: { authorization: string | null; url: string } = { authorization: null, url: '' }
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers)
      seen.authorization = headers.get('authorization')
      seen.url = String(input)
      // Minimal valid tRPC v11 batch response for a single query result.
      return new Response(JSON.stringify([{ result: { data: [] } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    // No createClient seam -> exercises the REAL default tRPC client + header fn.
    const client = createRemoteClient(
      opts({ server: { url: 'http://127.0.0.1:6543', token: 'secret-token' } }),
    )
    await client.search({ query: 'hello' } as never)

    expect(seen.authorization).toBe('Bearer secret-token')
    // tRPC appended the procedure path onto the normalized base URL.
    expect(seen.url).toContain('http://127.0.0.1:6543/memory.search')
  })
})
