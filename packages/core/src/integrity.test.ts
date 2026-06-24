import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Reach the embedded store for direct row assertions (test-only). */
function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

/**
 * A healthy DB reports clean integrity (plan §22, §12.2).
 *
 * After normal writes (manual facts + a reindex that populates FTS and vectors),
 * `checkIntegrity()` must find no problems: native PRAGMA checks pass, there are
 * no orphaned derived/reference rows, FTS membership matches canonical rows, and
 * no entity links dangle.
 */
describe('checkIntegrity on a healthy database (plan §22)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  it('reports ok:true with no problems after normal ingestion + reindex', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({
      scope,
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    naru.addMemory({ scope, text: 'The API rate limit is 100 requests per minute' })
    await naru.reindex()

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
  })

  it('reports ok:true on a brand-new empty database', () => {
    naru = Naru.open({ db: ':memory:' })
    const report = naru.checkIntegrity()
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
  })

  it('stays ok after a deliberate reindex (FTS rebuild is drift-free)', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'user' as const, key: 'me' }
    naru.addMemory({ scope, text: 'I drink coffee every morning' })
    await naru.reindex()
    // A second reindex must not introduce extra/missing FTS membership.
    await naru.reindex()
    expect(naru.checkIntegrity().ok).toBe(true)
  })

  it('checkIntegrity is read-only: row counts are unchanged', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({ scope, text: 'A persistent fact' })
    const store = storeOf(naru)
    const factsBefore = store.facts.listAll().length
    naru.checkIntegrity()
    naru.checkIntegrity()
    expect(store.facts.listAll().length).toBe(factsBefore)
  })
})
