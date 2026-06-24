import { type Fact, newFactId, nowIso, scopeKey, statementHash } from '@naru/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store'

function makeFact(scopeId: string, overrides: Partial<Fact> = {}): Fact {
  const now = nowIso()
  const predicate = overrides.predicate ?? 'prefers'
  const objectValue = overrides.objectValue ?? 'dark mode'
  return {
    id: overrides.id ?? newFactId(),
    scopeId,
    subjectEntityId: null,
    predicate,
    objectEntityId: null,
    objectValue,
    statement: overrides.statement ?? 'User prefers dark mode for developer tools.',
    statementHash: statementHash({
      scopeKey: scopeKey('user', 'sean'),
      subject: 'user',
      predicate,
      object: objectValue,
    }),
    confidence: 0.9,
    status: overrides.status ?? 'active',
    validFrom: null,
    validTo: null,
    observedAt: overrides.observedAt ?? now,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  }
}

describe('FactsRepository', () => {
  let store: Store
  let scopeKeyValue: string
  let scopeId: string

  beforeEach(() => {
    store = Store.open({ path: ':memory:' })
    const scope = store.scopes.ensure({ type: 'user', keyPart: 'sean' })
    scopeId = scope.id
    scopeKeyValue = scope.key
  })

  it('finds an indexed fact by term within the allowed scope', () => {
    const fact = store.facts.insert(makeFact(scopeId))
    store.facts.indexFact(fact, scopeKeyValue, 'User dark mode')

    const hits = store.facts.ftsSearch([scopeKeyValue], 'dark', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.fact.id).toBe(fact.id)
    expect(typeof hits[0]?.bm25).toBe('number')
  })

  it('does not return facts from scopes outside the allowed set', () => {
    const fact = store.facts.insert(makeFact(scopeId))
    store.facts.indexFact(fact, scopeKeyValue, 'User dark mode')

    const hits = store.facts.ftsSearch([scopeKey('project', 'other')], 'dark', 10)
    expect(hits).toHaveLength(0)
  })

  it('does not match a fact on its scope label (scope_key is UNINDEXED)', () => {
    const fact = store.facts.insert(makeFact(scopeId, { statement: 'Coffee tastes great today.' }))
    store.facts.indexFact(fact, scopeKeyValue, 'coffee')

    // `scopeKeyValue` is `user:sean`; querying the scope-type word "user" or the
    // key part "sean" must not match via the scope_key column.
    expect(store.facts.ftsSearch([scopeKeyValue], '"user"', 10)).toHaveLength(0)
    expect(store.facts.ftsSearch([scopeKeyValue], '"sean"', 10)).toHaveLength(0)
    // A real content term still matches.
    expect(store.facts.ftsSearch([scopeKeyValue], '"coffee"', 10)).toHaveLength(1)
  })

  it('current view excludes superseded facts but keeps active ones', () => {
    const active = store.facts.insert(makeFact(scopeId, { statement: 'User prefers Vitest.' }))
    const superseded = store.facts.insert(
      makeFact(scopeId, {
        statement: 'User prefers Jest.',
        status: 'superseded',
        predicate: 'used',
        objectValue: 'jest',
      }),
    )

    const view = store.facts.currentView([scopeKeyValue], 50)
    const ids = view.map((f) => f.id)
    expect(ids).toContain(active.id)
    expect(ids).not.toContain(superseded.id)
  })

  it('deleteById removes the canonical row and its FTS row', () => {
    const fact = store.facts.insert(makeFact(scopeId))
    store.facts.indexFact(fact, scopeKeyValue, 'User dark mode')
    expect(store.facts.ftsSearch([scopeKeyValue], 'dark', 10)).toHaveLength(1)

    store.facts.deleteById(fact.id)

    expect(store.facts.getById(fact.id)).toBeUndefined()
    expect(store.facts.ftsSearch([scopeKeyValue], 'dark', 10)).toHaveLength(0)
  })
})
