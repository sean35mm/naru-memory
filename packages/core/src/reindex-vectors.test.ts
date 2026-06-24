import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Minimal view of the embedded store for direct row assertions. */
interface RawDb {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

/** Count `fact_vectors` rows directly (the derived vector index, plan §11.9). */
function vectorCount(naru: Naru): number {
  const store = (naru as unknown as { store: { db: RawDb } }).store
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM fact_vectors').get() as { n: number }
  return row.n
}

/**
 * Vector index rebuildability from canonical facts (plan §12.2).
 *
 * Vectors are a derived, rebuildable index: dropping every `fact_vectors` row and
 * re-embedding from each fact's canonical (already-redacted) `statement` must
 * restore semantic retrieval, proving the §12.2 caveat ("vectors regenerate from
 * retained source text + an available embedder"). Uses the deterministic,
 * no-network MockEmbedder, whose cosine tracks token overlap, so a paraphrased
 * query lexically disjoint from the statement is surfaced purely via KNN.
 */
describe('reindex rebuilds vectors from canonical facts (plan §12.2)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('drops and rebuilds the vector index; semantic search still works', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const target = naru.addMemory({
      text: 'The user prefers dark colour themes in developer tooling',
      scope,
    })
    naru.addMemory({ text: 'Invoices are settled monthly by the billing department', scope })
    await naru.reindexVectors()
    expect(vectorCount(naru)).toBe(2)

    // Lexically disjoint paraphrase: only KNN can surface the target.
    const query = 'preferred appearance scheme for coding environment'
    const beforeRebuild = await naru.searchHybrid({ query, scope })
    expect(beforeRebuild[0]?.factId).toBe(target.id)
    expect(beforeRebuild[0]?.reasons).toContain('vector')

    // Drop the entire derived vector index, leaving canonical facts intact.
    const store = (naru as unknown as { store: { vectors: { clearVectors(): void } } }).store
    store.vectors.clearVectors()
    expect(vectorCount(naru)).toBe(0)

    // With vectors gone, the lexically disjoint query no longer finds the target.
    const afterDrop = await naru.searchHybrid({ query, scope })
    expect(afterDrop.some((r) => r.factId === target.id)).toBe(false)

    // Rebuild from canonical facts: the vector index is fully restored.
    const rebuilt = await naru.reindexVectors()
    expect(rebuilt.embedded).toBe(2)
    expect(vectorCount(naru)).toBe(2)

    // Semantic retrieval works again, identical to before the drop.
    const afterRebuild = await naru.searchHybrid({ query, scope })
    expect(afterRebuild[0]?.factId).toBe(target.id)
    expect(afterRebuild[0]?.reasons).toContain('vector')
  })

  it('reindex() rebuilds BOTH FTS and vectors from canonical rows', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const target = naru.addMemory({
      text: 'The user prefers dark colour themes in developer tooling',
      scope,
    })
    naru.addMemory({ text: 'The deployment runbook lives in the ops wiki', scope })
    await naru.reindexVectors()
    expect(vectorCount(naru)).toBe(2)

    // Wipe both derived indexes out from under canonical facts.
    const store = (
      naru as unknown as {
        store: { vectors: { clearVectors(): void }; facts: { clearFts(): void } }
      }
    ).store
    store.vectors.clearVectors()
    store.facts.clearFts()
    expect(vectorCount(naru)).toBe(0)
    // FTS is empty -> a lexical query finds nothing.
    expect(naru.search({ query: 'dark colour themes', scope })).toEqual([])

    // The combined reindex regenerates BOTH from canonical facts.
    await naru.reindex()
    expect(vectorCount(naru)).toBe(2)

    // FTS restored: lexical search finds the fact again.
    const lexical = naru.search({ query: 'dark colour themes', scope })
    expect(lexical.some((r) => r.factId === target.id)).toBe(true)

    // Vector index restored: the lexically disjoint paraphrase is surfaced via KNN.
    const semantic = await naru.searchHybrid({
      query: 'preferred appearance scheme for coding environment',
      scope,
    })
    expect(semantic[0]?.factId).toBe(target.id)
    expect(semantic[0]?.reasons).toContain('vector')
  })

  it('with no embedder configured, reindex rebuilds FTS only (vectors stay OFF)', async () => {
    const plain = Naru.open({ db: ':memory:' })
    try {
      const scope = { type: 'project' as const, key: 'app' }
      const fact = plain.addMemory({ text: 'The API rate limit is 100 requests per minute', scope })
      // No embedder -> no vectors ever, even after a deliberate reindex.
      await plain.reindex()
      expect(vectorCount(plain)).toBe(0)
      // FTS still rebuilt: lexical search works (no regression vs M1/M2).
      const lexical = plain.search({ query: 'rate limit', scope })
      expect(lexical.some((r) => r.factId === fact.id)).toBe(true)
    } finally {
      plain.close()
    }
  })
})
