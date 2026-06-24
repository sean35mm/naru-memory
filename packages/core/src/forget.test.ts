import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('forget (plan §18.2)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('destructively purges the fact and its facts_fts row', () => {
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({
      text: 'The database migration runs on startup.',
      scope,
    })

    // Confirm search finds it.
    const before = naru.search({ query: 'migration startup', scope })
    expect(before.map((r) => r.factId)).toContain(fact.id)

    // Confirm the FTS row exists (query the store directly).
    interface RawDb {
      prepare(sql: string): { get(...params: unknown[]): unknown }
    }
    const store = (naru as unknown as { store: { db: RawDb } }).store
    const ftsBefore = store.db
      .prepare('SELECT COUNT(*) AS n FROM facts_fts WHERE fact_id = ?')
      .get(fact.id) as { n: number }
    expect(ftsBefore.n).toBe(1)

    const result = naru.forget({ factId: fact.id })
    expect(result.deleted).toBe(1)

    // Search returns nothing.
    const after = naru.search({ query: 'migration startup', scope })
    expect(after.map((r) => r.factId)).not.toContain(fact.id)

    // The canonical fact is gone.
    expect(naru.get(fact.id)).toBeUndefined()

    // The facts_fts row is gone.
    const ftsAfter = store.db
      .prepare('SELECT COUNT(*) AS n FROM facts_fts WHERE fact_id = ?')
      .get(fact.id) as { n: number }
    expect(ftsAfter.n).toBe(0)
  })

  it('purges orphaned episodes (redacted source text) for scope and factId forgets', () => {
    interface RawDb {
      prepare(sql: string): { get(...params: unknown[]): unknown }
    }
    const store = (naru as unknown as { store: { db: RawDb } }).store
    const episodeCount = (): number =>
      (store.db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number }).n

    // Scope forget: facts AND their now-orphaned source episodes are purged.
    const scope = { type: 'project' as const, key: 'leakproj' }
    naru.addMemory({ text: 'fact one in leakproj', scope })
    naru.addMemory({ text: 'fact two in leakproj', scope })
    expect(episodeCount()).toBe(2)
    naru.forget({ scope })
    expect(episodeCount()).toBe(0)

    // factId forget: the single source episode is purged too.
    const lone = naru.addMemory({ text: 'lonely fact', scope })
    expect(episodeCount()).toBe(1)
    naru.forget({ factId: lone.id })
    expect(episodeCount()).toBe(0)
  })
})
