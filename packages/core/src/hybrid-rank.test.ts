import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Hybrid retrieval with the deterministic MockEmbedder (plan §14).
 *
 * The mock is a no-network, bag-of-tokens hashing embedder: cosine similarity
 * tracks token overlap. These tests exercise the vector candidate source +
 * normalized weighted-linear ranker on top of the lexical/entity sources, and
 * assert the §9.4/§14.3 scope + current-view gates hold even when a fact is
 * pulled in by the vector signal.
 */
describe('hybrid rank with vector signal (plan §14)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('surfaces a fact via the vector signal that pure BM25 misses', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    // Two facts whose statements share NO token with the query below, so FTS
    // MATCH returns nothing for either — pure BM25 retrieval finds neither.
    const target = naru.addMemory({
      text: 'The user prefers dark colour themes in developer tooling',
      scope,
    })
    naru.addMemory({ text: 'Invoices are settled monthly by the billing department', scope })
    // Vectors are populated by the deliberate reindex (the sync addMemory path
    // does not embed inline; §12.2 treats vector build as an explicit op).
    await naru.reindexVectors()

    // Paraphrased query: lexically disjoint from both statements, semantically
    // closest to the target (more shared hashing-buckets => higher cosine).
    const query = 'preferred appearance scheme for coding environment'

    // Synchronous lexical/entity search (no query embedding) finds nothing:
    // this is exactly what "pure BM25 would miss".
    expect(naru.search({ query, scope })).toEqual([])

    // Hybrid search embeds the query and retrieves via scope-filtered KNN.
    const hybrid = await naru.searchHybrid({ query, scope })
    expect(hybrid.length).toBeGreaterThan(0)
    expect(hybrid[0]?.factId).toBe(target.id)
    // The top hit was contributed by the vector source, not BM25.
    expect(hybrid[0]?.reasons).toContain('vector')
    expect(hybrid[0]?.reasons).not.toContain('bm25')
  })

  it('records the vector signal contribution in reasons and lifts the score', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({
      text: 'For dependency installation the team standardized on the pnpm package manager',
      scope,
    })
    await naru.reindexVectors()

    const query = 'which package manager did the team standardize on'
    const lexical = naru.search({ query, scope })
    const hybrid = await naru.searchHybrid({ query, scope })

    const lex = lexical.find((r) => r.factId === fact.id)
    const hyb = hybrid.find((r) => r.factId === fact.id)
    expect(lex).toBeDefined()
    expect(hyb).toBeDefined()
    // Lexical hit carries bm25; hybrid hit carries BOTH bm25 and vector, and the
    // extra normalized cosine term raises the combined score (plan §14.2).
    expect(lex?.reasons).toContain('bm25')
    expect(lex?.reasons).not.toContain('vector')
    expect(hyb?.reasons).toEqual(expect.arrayContaining(['bm25', 'vector']))
    expect(hyb?.score ?? 0).toBeGreaterThan(lex?.score ?? 0)
  })

  it('vector similarity never pulls a fact across scope boundaries (plan §9.4/§18.3)', async () => {
    naru.addMemory({
      text: 'The deploy command for AlphaService is pnpm deploy alpha',
      scope: { type: 'project', key: 'a' },
    })
    naru.addMemory({
      text: 'The deploy command for BetaService is pnpm deploy beta',
      scope: { type: 'project', key: 'b' },
    })
    await naru.reindexVectors()

    const inA = await naru.searchHybrid({
      query: 'deployment release ship command instructions',
      scope: { type: 'project', key: 'a' },
    })
    expect(inA.length).toBeGreaterThan(0)
    expect(inA.every((r) => r.scope === 'project:a')).toBe(true)
    expect(inA.some((r) => /Beta/.test(r.statement))).toBe(false)
  })

  it('excludes a superseded fact from the current view even when the vector matches it', async () => {
    const scope = { type: 'project' as const, key: 'editor' }
    const oldFact = naru.addMemory({ text: 'The user prefers light mode in the editor', scope })
    const newFact = naru.addMemory({ text: 'The user prefers dark mode in the editor', scope })
    naru.supersede(oldFact.id, newFact.id, 'changed preference')
    await naru.reindexVectors()

    const query = 'editor colour preference appearance mode'
    const current = await naru.searchHybrid({ query, scope })
    // The superseded old fact must not appear; its active replacement does.
    expect(current.some((r) => r.factId === oldFact.id)).toBe(false)
    expect(current.some((r) => r.factId === newFact.id)).toBe(true)

    // History view may include the superseded fact (plan §14.3).
    const history = await naru.searchHybrid({ query, scope, includeHistory: true })
    expect(history.some((r) => r.factId === oldFact.id)).toBe(true)
  })

  it('with no embedder configured, hybrid search behaves like lexical search (no regression)', async () => {
    const plain = Naru.open({ db: ':memory:' })
    try {
      const scope = { type: 'project' as const, key: 'app' }
      plain.addMemory({ text: 'The API rate limit is 100 requests per minute', scope })
      const query = 'rate limit'
      const sync = plain.search({ query, scope })
      const hybrid = await plain.searchHybrid({ query, scope })
      expect(hybrid.map((r) => r.factId)).toEqual(sync.map((r) => r.factId))
      // No vector reason is ever emitted when vector retrieval is OFF.
      expect(hybrid.every((r) => !r.reasons.includes('vector'))).toBe(true)
    } finally {
      plain.close()
    }
  })
})
