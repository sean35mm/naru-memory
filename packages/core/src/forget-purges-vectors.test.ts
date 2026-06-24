import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Minimal view of the embedded store for direct row assertions. */
interface RawDb {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

/** Count `fact_vectors` rows for a specific fact (the derived vector index). */
function vectorCountFor(naru: Naru, factId: string): number {
  const store = (naru as unknown as { store: { db: RawDb } }).store
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM fact_vectors WHERE fact_id = ?')
    .get(factId) as { n: number }
  return row.n
}

/**
 * Privacy purge drops the derived vector index too (plan §18.2).
 *
 * `memory.forget` is a destructive privacy delete: it must purge a fact's vector
 * along with its canonical row, evidence, edges, and FTS row (§18.2 lists
 * embeddings explicitly). A lingering vector would leave a forgotten statement
 * semantically retrievable — the exact leak forget exists to prevent. Uses the
 * deterministic no-network MockEmbedder.
 */
describe('forget purges vectors (plan §18.2)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('drops the vector row and removes the fact from semantic search', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const secretish = naru.addMemory({
      text: 'The user prefers dark colour themes in developer tooling',
      scope,
    })
    naru.addMemory({ text: 'Invoices are settled monthly by the billing department', scope })
    await naru.reindexVectors()
    expect(vectorCountFor(naru, secretish.id)).toBe(1)

    // A lexically disjoint paraphrase surfaces the fact purely via KNN first.
    const query = 'preferred appearance scheme for coding environment'
    const before = await naru.searchHybrid({ query, scope })
    expect(before.some((r) => r.factId === secretish.id)).toBe(true)

    const result = naru.forget({ factId: secretish.id })
    expect(result.deleted).toBe(1)

    // The canonical fact AND its derived vector row are gone.
    expect(naru.get(secretish.id)).toBeUndefined()
    expect(vectorCountFor(naru, secretish.id)).toBe(0)

    // Semantic search no longer surfaces the forgotten fact (no lingering vector).
    const after = await naru.searchHybrid({ query, scope })
    expect(after.some((r) => r.factId === secretish.id)).toBe(false)
  })

  it('a scope forget purges every vector in that scope', async () => {
    const scope = { type: 'project' as const, key: 'leakproj' }
    const f1 = naru.addMemory({ text: 'first deployment runbook step in leakproj', scope })
    const f2 = naru.addMemory({ text: 'second deployment runbook step in leakproj', scope })
    await naru.reindexVectors()
    expect(vectorCountFor(naru, f1.id)).toBe(1)
    expect(vectorCountFor(naru, f2.id)).toBe(1)

    const result = naru.forget({ scope })
    expect(result.deleted).toBe(2)
    expect(vectorCountFor(naru, f1.id)).toBe(0)
    expect(vectorCountFor(naru, f2.id)).toBe(0)
  })
})
