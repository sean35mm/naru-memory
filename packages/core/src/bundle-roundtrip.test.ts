import { newEdgeId, nowIso } from '@naru/schema'
import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Reach the embedded store for direct row assertions / edge seeding. */
function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

/** Count rows in a canonical table directly. */
function count(naru: Naru, table: string): number {
  const row = storeOf(naru).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

/**
 * Seed a multi-scope corpus: a project scope with two facts (one superseded by
 * the other, forming a supersession) plus entities/evidence from the manual add
 * path, a user scope with one fact, and a hand-built fact->fact edge.
 */
function seed(naru: Naru): { supersededId: string; activeId: string } {
  // project scope: subject/predicate/object so entities + evidence are created.
  const f1 = naru.addMemory({
    scope: { type: 'project', key: 'webapp' },
    text: 'Alice prefers dark mode',
    subject: 'Alice',
    predicate: 'prefers',
    object: 'dark mode',
  })
  const f2 = naru.addMemory({
    scope: { type: 'project', key: 'webapp' },
    text: 'Alice prefers light mode',
    subject: 'Alice',
    predicate: 'prefers',
    object: 'light mode',
  })
  naru.supersede(f1.id, f2.id, 'changed preference')

  // user scope: a second scope so multi-scope export/import is exercised.
  naru.addMemory({
    scope: { type: 'user', key: 'alice' },
    text: 'Alice works in the Pacific timezone',
  })

  // A typed fact->fact edge (no facade write path creates one in M1-M4).
  const store = storeOf(naru)
  store.edges.insert({
    id: newEdgeId(),
    scopeId: f2.scopeId,
    sourceType: 'fact',
    sourceId: f1.id,
    predicate: 'relates_to',
    targetType: 'fact',
    targetId: f2.id,
    confidence: 0.9,
    metadata: {},
    createdAt: nowIso(),
  })

  return { supersededId: f1.id, activeId: f2.id }
}

describe('bundle roundtrip (plan §19)', () => {
  const open: Naru[] = []
  const make = (): Naru => {
    const n = Naru.open({ db: ':memory:' })
    open.push(n)
    return n
  }

  afterEach(() => {
    for (const n of open.splice(0)) {
      n.close()
    }
  })

  it('exports a multi-scope corpus and reimports it into a fresh DB with matching canonical rows', async () => {
    const source = make()
    seed(source)
    const bundle = source.exportBundle()

    // Sanity: the export carries every canonical table.
    expect(bundle.scopes.length).toBe(count(source, 'scopes'))
    expect(bundle.facts.length).toBe(count(source, 'facts'))
    expect(bundle.entities.length).toBe(count(source, 'entities'))
    expect(bundle.evidence.length).toBe(count(source, 'evidence'))
    expect(bundle.episodes.length).toBe(count(source, 'episodes'))
    expect(bundle.edges.length).toBe(1)
    expect(bundle.supersessions.length).toBe(1)

    const target = make()
    const result = await target.importBundle(bundle)

    // Every canonical row landed (fresh DB -> no duplicates skipped).
    expect(result.skippedDuplicates).toBe(0)
    expect(result.imported.scopes).toBe(bundle.scopes.length)
    expect(result.imported.facts).toBe(bundle.facts.length)
    expect(result.imported.entities).toBe(bundle.entities.length)
    expect(result.imported.evidence).toBe(bundle.evidence.length)
    expect(result.imported.episodes).toBe(bundle.episodes.length)
    expect(result.imported.edges).toBe(1)
    expect(result.imported.supersessions).toBe(1)

    // Canonical row counts match the source store.
    expect(count(target, 'facts')).toBe(count(source, 'facts'))
    expect(count(target, 'entities')).toBe(count(source, 'entities'))
    expect(count(target, 'evidence')).toBe(count(source, 'evidence'))
    expect(count(target, 'episodes')).toBe(count(source, 'episodes'))
    expect(count(target, 'edges')).toBe(1)
    expect(count(target, 'supersessions')).toBe(1)

    // No embedder configured -> a re-embed-needed warning, vectors left empty.
    expect(result.vectorsRebuilt).toBeUndefined()
    expect(result.reembedNeeded).toBeDefined()
    expect(count(target, 'fact_vectors')).toBe(0)
  })

  it('rebuilds FTS on import so lexical search works against the imported store', async () => {
    const source = make()
    seed(source)
    const bundle = source.exportBundle()

    const target = make()
    await target.importBundle(bundle)

    // FTS was rebuilt from canonical rows: the active fact is findable, the
    // superseded one is filtered out of the current view.
    const hits = target.search({ query: 'light mode', scope: { type: 'project', key: 'webapp' } })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => /light mode/i.test(h.statement))).toBe(true)

    const darkHits = target.search({
      query: 'dark mode',
      scope: { type: 'project', key: 'webapp' },
    })
    // "dark mode" is the superseded statement; current view excludes it.
    expect(darkHits.some((h) => /dark mode/i.test(h.statement))).toBe(false)

    // The user-scope fact is searchable too (multi-scope import).
    const tzHits = target.search({
      query: 'Pacific timezone',
      scope: { type: 'user', key: 'alice' },
    })
    expect(tzHits.length).toBeGreaterThan(0)
  })

  it('preserves portable ids when the target DB is empty', async () => {
    const source = make()
    const { activeId } = seed(source)
    const bundle = source.exportBundle()

    const target = make()
    await target.importBundle(bundle)

    // No collisions on a fresh DB -> the active fact id is preserved verbatim.
    expect(target.get(activeId)?.fact.id).toBe(activeId)
  })

  it('rebuilds vectors on import when an embedder is configured', async () => {
    const source = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    open.push(source)
    seed(source)
    await source.reindexVectors()
    const bundle = source.exportBundle()
    // The bundle carries the embedder provenance for the re-embed caveat.
    expect(bundle.embedding).toEqual({ provider: 'mock', model: 'mock-64', dimension: 64 })

    const target = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    open.push(target)
    const result = await target.importBundle(bundle)

    expect(result.reembedNeeded).toBeUndefined()
    expect(result.vectorsRebuilt?.embedded).toBeGreaterThan(0)
    expect(count(target, 'fact_vectors')).toBeGreaterThan(0)
    // Same embedder both sides -> no mismatch warning.
    expect(result.embeddingMismatch).toBeUndefined()
  })

  it('warns when the configured embedder differs from the bundle embedding (plan §19)', async () => {
    const source = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    open.push(source)
    seed(source)
    await source.reindexVectors()
    const bundle = source.exportBundle()
    expect(bundle.embedding).toEqual({ provider: 'mock', model: 'mock-64', dimension: 64 })

    // Simulate a bundle exported under a DIFFERENT model than the importing box
    // is configured with (e.g. openai/text-embedding-3-small/1536 vs mock/mock-64).
    const foreign = {
      ...bundle,
      embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 },
    }

    const target = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    open.push(target)
    const result = await target.importBundle(foreign)

    // Facts were re-embedded under the LIVE embedder, but it differs from the
    // bundle's recorded provenance -> a mismatch warning surfaces both spaces.
    expect(result.vectorsRebuilt?.embedded).toBeGreaterThan(0)
    expect(result.embeddingMismatch).toBeDefined()
    expect(result.embeddingMismatch?.reembeddedUnder).toEqual({
      provider: 'mock',
      model: 'mock-64',
      dimension: 64,
    })
    expect(result.embeddingMismatch?.bundleEmbedding).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
    })
  })
})
