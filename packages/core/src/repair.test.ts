import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Reach the embedded store for direct row manipulation (test-only). */
function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

/** Run `fn` with `foreign_keys` temporarily OFF to fabricate referential drift. */
function withForeignKeysOff(store: Store, fn: () => void): void {
  store.db.pragma('foreign_keys = OFF')
  try {
    fn()
  } finally {
    store.db.pragma('foreign_keys = ON')
  }
}

/**
 * repair() rebuilds derived indexes and prunes orphans from canonical data, then
 * a subsequent checkIntegrity() is ok — and canonical facts are untouched and
 * still searchable (plan §22, §12.2: repair fixes derived state, never deletes a
 * canonical fact).
 */
describe('repair rebuilds derived state and prunes orphans (plan §22, §12.2)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  it('rebuilds FTS after it is cleared; facts stay searchable', async () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({ scope, text: 'The API rate limit is 100 requests per minute' })

    // Corrupt derived state: wipe facts_fts out from under the canonical fact.
    const store = storeOf(naru)
    store.facts.clearFts()
    expect(naru.search({ query: 'rate limit', scope })).toEqual([])
    expect(naru.checkIntegrity().ok).toBe(false) // facts_fts_missing

    const result = await naru.repair()
    expect(result.ftsRebuilt).toBe(true)
    expect(result.report.ok).toBe(true)

    // Canonical fact untouched and searchable again.
    expect(store.facts.getById(fact.id)).toBeDefined()
    const hits = naru.search({ query: 'rate limit', scope })
    expect(hits.some((h) => h.factId === fact.id)).toBe(true)
  })

  it('prunes an orphaned vector and rebuilds the vector index from canonical', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'project' as const, key: 'app' }
    const target = naru.addMemory({
      scope,
      text: 'The user prefers dark colour themes in developer tooling',
    })
    await naru.reindexVectors()
    const store = storeOf(naru)

    // Insert a vector for a fact that does not exist -> orphan derived row.
    // fact_vectors.fact_id has an FK to facts, so turn FK enforcement off to
    // fabricate the orphan (models a vector left behind by drift).
    withForeignKeysOff(store, () => {
      store.vectors.upsertVector('ghost-fact-id', {
        provider: 'mock',
        model: 'mock-64',
        dimension: 64,
        vector: Float32Array.from(new Array(64).fill(0.1)),
        sourceHash: 'ghost-hash',
      })
    })
    expect(naru.checkIntegrity().ok).toBe(false) // orphan_fact_vectors

    const result = await naru.repair()
    expect(result.pruned.factVectors).toBe(1)
    expect(result.vectorsRebuilt).toEqual({ embedded: 1 })
    expect(result.report.ok).toBe(true)

    // Canonical fact untouched; semantic retrieval works again.
    expect(store.facts.getById(target.id)).toBeDefined()
    const semantic = await naru.searchHybrid({
      query: 'preferred appearance scheme for coding environment',
      scope,
    })
    expect(semantic[0]?.factId).toBe(target.id)
    expect(semantic[0]?.reasons).toContain('vector')
  })

  it('prunes orphan evidence/supersessions and clears dangling links without deleting facts', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const linkedFact = naru.addMemory({
      scope,
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    const oldFact = naru.addMemory({ scope, text: 'The value was A' })
    const newFact = naru.addMemory({ scope, text: 'The value is now B' })
    naru.supersede(oldFact.id, newFact.id, 'changed')

    const store = storeOf(naru)
    const subjectId = store.facts.getById(linkedFact.id)?.subjectEntityId
    const factCountBefore = store.facts.listAll().length

    // Fabricate three drift conditions at once (FK off so they survive):
    // - dangling entity link (entity deleted)
    // - orphan supersession (new fact deleted)
    // - orphan evidence (insert evidence referencing a missing fact)
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM entities WHERE id = ?').run(subjectId)
      store.db.prepare('DELETE FROM facts WHERE id = ?').run(newFact.id)
      store.evidence.insert({
        id: 'ev-dangling',
        factId: 'missing-fact-id',
        episodeId: 'missing-episode-id',
        spanStart: null,
        spanEnd: null,
        redactedQuote: null,
        quoteHash: null,
        extractorName: 'manual',
        extractorVersion: '1',
        createdAt: new Date().toISOString(),
      })
    })

    expect(naru.checkIntegrity().ok).toBe(false)

    return naru.repair().then((result) => {
      expect(result.report.ok).toBe(true)
      expect(result.pruned.evidence).toBeGreaterThanOrEqual(1)
      expect(result.pruned.supersessions).toBe(1)
      expect(result.danglingEntityLinksCleared).toBe(1)

      // The deleted newFact is gone (we deleted it), but no OTHER canonical fact
      // was removed by repair — only derived/orphan rows + the dangling link.
      expect(store.facts.listAll().length).toBe(factCountBefore - 1)
      // The linked fact survives; its dangling subject link was cleared to NULL.
      const relinked = store.facts.getById(linkedFact.id)
      expect(relinked).toBeDefined()
      expect(relinked?.subjectEntityId).toBeNull()
    })
  })

  it('is idempotent: a second repair on a clean DB is a no-op for pruning', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({ scope, text: 'A fact to keep' })
    await naru.reindex()

    const first = await naru.repair()
    expect(first.report.ok).toBe(true)

    const second = await naru.repair()
    expect(second.report.ok).toBe(true)
    expect(second.pruned).toEqual({ evidence: 0, factVectors: 0, edges: 0, supersessions: 0 })
    expect(second.danglingEntityLinksCleared).toBe(0)
  })

  it('repair recomputes index_state to fresh for the rebuilt indexes (plan §22)', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    naru.addMemory({ scope: { type: 'project', key: 'app' }, text: 'A fact' })
    await naru.repair()

    const states = naru.indexStatus()
    const factsFts = states.find((s) => s.indexName === 'facts_fts')
    expect(factsFts?.status).toBe('fresh')
    expect(factsFts?.lastRebuiltAt).toBeTruthy()
  })

  it('repair honors the §12.3 admin-write guard (refuses behind a live server)', async () => {
    naru = Naru.open({
      db: ':memory:',
      adminWriteGuard: () => {
        throw new Error('a live server owns this DB; proxy admin writes to it')
      },
    })
    naru.addMemory({ scope: { type: 'project', key: 'app' }, text: 'A fact' })
    await expect(naru.repair()).rejects.toThrow('live server owns this DB')
  })

  it('re-homes an orphan-by-scope fact and converges to ok (plan §22, §12.2)', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({ scope, text: 'The deploy runbook lives in the ops wiki' })
    await naru.reindexVectors()
    const store = storeOf(naru)

    // Orphan the fact (+ its episode/entity) by deleting its scope with FK off:
    // a canonical row whose scope_id now references a missing scope (corruption
    // from tampering or a partial restore).
    const orphanScope = store.scopes.list()[0]
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM scopes WHERE id = ?').run(orphanScope?.id)
    })

    const before = naru.checkIntegrity()
    expect(before.ok).toBe(false)
    expect(before.problems.some((p) => p.kind === 'orphan_by_scope')).toBe(true)

    // First repair re-homes the canonical rows (never deletes them) and converges.
    const first = await naru.repair()
    expect(first.rehomedByScope.facts).toBe(1)
    expect(first.report.ok).toBe(true)

    // Idempotent-to-clean: a second repair finds nothing to re-home and stays ok.
    const second = await naru.repair()
    expect(second.report.ok).toBe(true)
    expect(second.rehomedByScope).toEqual({ facts: 0, episodes: 0, entities: 0 })

    // The canonical fact survived and is searchable + vector-indexed again — it
    // was NOT silently dropped from the derived indexes (the §22 gap this fixes).
    expect(store.facts.getById(fact.id)).toBeDefined()
    expect(store.vectors.getVector(fact.id)).toBeDefined()
    const rehomed = store.facts.getById(fact.id)
    const recoveredScope = rehomed ? store.scopes.getById(rehomed.scopeId) : undefined
    expect(recoveredScope?.key).toBe('agent:naru-recovered')
    const hits = await naru.searchHybrid({
      query: 'deploy runbook',
      scope: { type: 'agent', key: 'naru-recovered' },
    })
    expect(hits.some((h) => h.factId === fact.id)).toBe(true)
  })
})
