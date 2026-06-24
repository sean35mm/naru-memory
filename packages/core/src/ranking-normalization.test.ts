import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Ranking-normalization gates (plan §14.2): scope priority and current-view /
 * temporal validity are GATES, not additive terms, so a strong vector (cosine)
 * score can never rank an out-of-scope or superseded fact into the result set.
 * Scope + current-view are applied BEFORE the weighted-linear combine (§9.4 safe
 * pattern: resolve scope -> retrieve in-scope -> filter -> rank).
 */
describe('ranking normalization gates (plan §14.2, §9.4)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('a near-perfect vector match in a foreign scope is never ranked in', async () => {
    // The SAME statement exists in two scopes. A query identical to that
    // statement yields a maximal cosine for BOTH facts — but only the in-scope
    // one may ever appear when searching a single scope.
    const statement = 'The user prefers compact spacing in the dashboard layout'
    const inScope = naru.addMemory({ text: statement, scope: { type: 'project', key: 'a' } })
    const foreign = naru.addMemory({ text: statement, scope: { type: 'project', key: 'b' } })
    await naru.reindexVectors()

    const results = await naru.searchHybrid({
      query: statement,
      scope: { type: 'project', key: 'a' },
    })
    expect(results.some((r) => r.factId === inScope.id)).toBe(true)
    // The foreign-scope twin has an identical (maximal) cosine yet is gated out
    // by scope resolution before ranking — a high vector score cannot leak it.
    expect(results.some((r) => r.factId === foreign.id)).toBe(false)
    expect(results.every((r) => r.scope === 'project:a')).toBe(true)
  })

  it('a near-perfect vector match against a superseded fact is never ranked in', async () => {
    const scope = { type: 'project' as const, key: 'editor' }
    const oldFact = naru.addMemory({
      text: 'The user prefers tabs over spaces for indentation',
      scope,
    })
    const newFact = naru.addMemory({
      text: 'The user prefers spaces over tabs for indentation',
      scope,
    })
    naru.supersede(oldFact.id, newFact.id, 'changed preference')
    await naru.reindexVectors()

    // Query is the OLD fact's exact statement: it is the maximal-cosine neighbor
    // of the superseded fact, yet the current view must exclude it (plan §14.3).
    const results = await naru.searchHybrid({ query: oldFact.statement, scope })
    expect(results.some((r) => r.factId === oldFact.id)).toBe(false)
    // The active replacement is still retrievable.
    expect(results.some((r) => r.factId === newFact.id)).toBe(true)
  })

  it('normalizes bm25 and cosine independently so neither scale dominates by units', async () => {
    // Two in-scope facts; the query matches both lexically and semantically.
    // We only assert the combined scores are finite, bounded, and ordered — a
    // smoke test that the per-signal normalization produces a sane [0,1]-ish
    // weighted sum rather than raw-scale (negative bm25 / unbounded) leakage.
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({ text: 'The service exposes a health check endpoint at slash health', scope })
    naru.addMemory({ text: 'The service exposes a metrics endpoint at slash metrics', scope })
    await naru.reindexVectors()

    const results = await naru.searchHybrid({ query: 'service endpoint health metrics', scope })
    expect(results.length).toBe(2)
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true)
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    }
    // Results are returned in non-increasing score order.
    expect(results[0]?.score ?? 0).toBeGreaterThanOrEqual(results[1]?.score ?? 0)
  })
})
