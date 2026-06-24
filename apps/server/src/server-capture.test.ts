import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppRouter } from '@naru/api'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './server'

/** Build a typed client bound to `url` with a bearer token. */
function clientFor(url: string, token: string) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url, headers: { authorization: `Bearer ${token}` } })],
  })
}

describe('@naru/server memory.capture (plan §13, §12.3 single-writer queue)', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  /** Fresh on-disk DB under a temp dir; never a real user DB. */
  function freshDb(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'naru-server-capture-'))
    return join(tmpDir, 'naru.db')
  }

  it('captures a multi-fact episode via the mock extractor and the facts are searchable', async () => {
    // The deterministic mock extractor segments sentences -> >1 fact; no network.
    const handle = await createServer({ db: freshDb(), port: 0, llm: { provider: 'mock' } })
    try {
      const client = clientFor(handle.url, handle.token)
      const scope = { type: 'project' as const, key: 'app' }

      const result = await client.memory.capture.mutate({
        text: 'User prefers dark mode. The API rate limit is 100 requests per minute.',
        scope,
      })

      // The episode is durably stored and extraction produced multiple facts.
      expect(result.episode.id).toMatch(/^ep_/)
      expect(result.facts.length).toBeGreaterThan(1)
      for (const fact of result.facts) {
        expect(fact.id).toMatch(/^fact_/)
        expect(fact.status).toBe('active')
      }

      // The extracted facts are retrievable within the same scope.
      const darkHits = await client.memory.search.query({ query: 'dark mode', scope })
      expect(darkHits.some((r) => /dark mode/i.test(r.statement))).toBe(true)

      const rateHits = await client.memory.search.query({ query: 'rate limit', scope })
      expect(rateHits.some((r) => /rate limit/i.test(r.statement))).toBe(true)

      // The capture facts exist by id in the server's store.
      const factIds = new Set(result.facts.map((f) => f.id))
      const allHits = [...darkHits, ...rateHits]
      expect(allHits.some((r) => factIds.has(r.factId))).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('with no provider configured, capture still stores the episode (manual fallback, §13.3)', async () => {
    // No `llm` option => extractor unavailable; capture must not fail and the
    // redacted episode is preserved with a single manual fact.
    const handle = await createServer({ db: freshDb(), port: 0 })
    try {
      const client = clientFor(handle.url, handle.token)
      const scope = { type: 'user' as const, key: 'alice' }

      const result = await client.memory.capture.mutate({
        text: 'The build pipeline uses pnpm.',
        scope,
      })
      expect(result.episode.id).toMatch(/^ep_/)
      expect(result.facts.length).toBe(1)

      const hits = await client.memory.search.query({ query: 'pnpm', scope })
      expect(hits.some((r) => /pnpm/i.test(r.statement))).toBe(true)

      // Extractor is reported unavailable in status.
      const status = await client.system.status.query()
      expect(status.features.extractor).toEqual({ available: false })
    } finally {
      await handle.close()
    }
  })

  it('rejects scope.type==="global" without persisting (writable scope, §9.2)', async () => {
    const handle = await createServer({ db: freshDb(), port: 0, llm: { provider: 'mock' } })
    try {
      const client = clientFor(handle.url, handle.token)
      await expect(
        client.memory.capture.mutate({
          text: 'should not persist',
          // @ts-expect-error global is excluded from the writable scope selector
          scope: { type: 'global', key: 'x' },
        }),
      ).rejects.toBeTruthy()
      const scopes = await client.scope.list.query()
      expect(scopes.some((s) => s.type === 'global')).toBe(false)
    } finally {
      await handle.close()
    }
  })
})
