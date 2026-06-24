import { type Fact, newFactId, nowIso, scopeKey, statementHash } from '@naru/schema'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from './migrate'
import { Store } from './store'

/** Build a minimal active fact in a scope; only fields KNN cares about matter. */
function makeFact(scopeId: string, scopeKeyValue: string, overrides: Partial<Fact> = {}): Fact {
  const now = nowIso()
  const statement = overrides.statement ?? 'a fact'
  return {
    id: overrides.id ?? newFactId(),
    scopeId,
    subjectEntityId: null,
    predicate: 'states',
    objectEntityId: null,
    objectValue: null,
    statement,
    statementHash: statementHash({
      scopeKey: scopeKeyValue,
      predicate: 'states',
      object: statement,
    }),
    confidence: 1,
    status: overrides.status ?? 'active',
    validFrom: null,
    validTo: null,
    observedAt: now,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  }
}

const PROVIDER = 'mock'
const MODEL = 'mock-64'

function upsert(store: Store, factId: string, vector: number[]): void {
  store.vectors.upsertVector(factId, {
    provider: PROVIDER,
    model: MODEL,
    dimension: vector.length,
    vector: Float32Array.from(vector),
    sourceHash: `hash-${factId}`,
  })
}

describe('migration 0002 fact_vectors', () => {
  it('creates the fact_vectors table and is idempotent', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    runMigrations(db) // additive + idempotent re-run
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_vectors'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('fact_vectors')
    db.close()
  })
})

describe('VectorRepository', () => {
  let store: Store
  let scopeAId: string
  let scopeAKey: string
  let scopeBId: string
  let scopeBKey: string

  beforeEach(() => {
    store = Store.open({ path: ':memory:' })
    const a = store.scopes.ensure({ type: 'project', keyPart: 'alpha' })
    const b = store.scopes.ensure({ type: 'project', keyPart: 'beta' })
    scopeAId = a.id
    scopeAKey = a.key
    scopeBId = b.id
    scopeBKey = b.key
  })

  it('upsert + knn returns the nearest vector within scope', () => {
    const near = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'near' }))
    const far = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'far' }))
    // query ~ [1,0,0]; near aligns, far is orthogonal.
    upsert(store, near.id, [0.9, 0.1, 0])
    upsert(store, far.id, [0, 1, 0])

    const hits = store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5)
    expect(hits.map((h) => h.factId)).toEqual([near.id, far.id])
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1)
  })

  it('knn excludes facts in scopes outside the allowed set', () => {
    const inScope = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'in' }))
    const otherScope = store.facts.insert(makeFact(scopeBId, scopeBKey, { statement: 'out' }))
    upsert(store, inScope.id, [1, 0, 0])
    upsert(store, otherScope.id, [1, 0, 0]) // identical vector, foreign scope

    const hits = store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5)
    const ids = hits.map((h) => h.factId)
    expect(ids).toContain(inScope.id)
    expect(ids).not.toContain(otherScope.id)
  })

  it('knn excludes superseded and deleted facts (current view only)', () => {
    const active = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'active' }))
    const superseded = store.facts.insert(
      makeFact(scopeAId, scopeAKey, { statement: 'old', status: 'superseded' }),
    )
    const deleted = store.facts.insert(
      makeFact(scopeAId, scopeAKey, { statement: 'gone', status: 'deleted' }),
    )
    upsert(store, active.id, [1, 0, 0])
    upsert(store, superseded.id, [1, 0, 0])
    upsert(store, deleted.id, [1, 0, 0])

    const hits = store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5)
    expect(hits.map((h) => h.factId)).toEqual([active.id])
  })

  it('deleteVector removes the stored vector', () => {
    const fact = store.facts.insert(makeFact(scopeAId, scopeAKey))
    upsert(store, fact.id, [1, 0, 0])
    expect(store.vectors.getVector(fact.id)).toBeDefined()
    expect(store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5)).toHaveLength(1)

    store.vectors.deleteVector(fact.id)

    expect(store.vectors.getVector(fact.id)).toBeUndefined()
    expect(store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5)).toHaveLength(0)
  })

  it('upsert overwrites an existing vector in place (1:1 with fact)', () => {
    const fact = store.facts.insert(makeFact(scopeAId, scopeAKey))
    upsert(store, fact.id, [0, 1, 0])
    upsert(store, fact.id, [1, 0, 0])
    expect(store.vectors.count()).toBe(1)
    const stored = store.vectors.getVector(fact.id)
    expect(Array.from(stored?.vector ?? [])).toEqual([1, 0, 0])
  })

  it('roundtrips Float32 BLOBs faithfully', () => {
    const fact = store.facts.insert(makeFact(scopeAId, scopeAKey))
    const values = [0.5, -0.25, 0.125, 1, -1]
    upsert(store, fact.id, values)
    const stored = store.vectors.getVector(fact.id)
    expect(Array.from(stored?.vector ?? [])).toEqual(values)
    expect(stored?.dimension).toBe(values.length)
  })

  it('deleting the fact removes its vector via deleteById (purge path)', () => {
    const fact = store.facts.insert(makeFact(scopeAId, scopeAKey))
    upsert(store, fact.id, [1, 0, 0])
    store.facts.deleteById(fact.id)
    expect(store.vectors.getVector(fact.id)).toBeUndefined()
  })

  it('clearVectors drops all vectors for rebuild', () => {
    const f1 = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'one' }))
    const f2 = store.facts.insert(makeFact(scopeAId, scopeAKey, { statement: 'two' }))
    upsert(store, f1.id, [1, 0, 0])
    upsert(store, f2.id, [0, 1, 0])
    expect(store.vectors.count()).toBe(2)
    store.vectors.clearVectors()
    expect(store.vectors.count()).toBe(0)
  })

  it('skips candidates whose stored dimension differs from the query', () => {
    const f = store.facts.insert(makeFact(scopeAId, scopeAKey))
    upsert(store, f.id, [1, 0, 0, 0]) // dim 4
    const hits = store.vectors.knn([scopeAKey], Float32Array.from([1, 0, 0]), 5) // dim 3
    expect(hits).toHaveLength(0)
  })
})
