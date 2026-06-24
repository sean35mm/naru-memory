import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Exact-hash dedupe in the extraction pipeline (plan §13.5). Capturing the same
 * text twice attaches new evidence to the existing active fact rather than
 * inserting a duplicate.
 */
describe('dedupe by extraction (plan §13.5)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', llm: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('capturing identical text twice creates no duplicate facts', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const text = 'The API rate limit is 100 requests per minute.'

    const first = await naru.capture({ text, scope })
    expect(first.facts).toHaveLength(1)
    const factId = first.facts[0]?.id
    expect(factId).toBeDefined()

    const second = await naru.capture({ text, scope })
    expect(second.facts).toHaveLength(1)
    expect(second.facts[0]?.id).toBe(factId)

    // Exactly one active fact exists for the statement.
    const active = naru.list({ scope, status: 'active' })
    expect(active).toHaveLength(1)

    // The duplicate capture attached a second evidence row to the same fact
    // (provenance accrues; no new fact, plan §13.5 "attach evidence").
    const got = naru.get(factId ?? '')
    expect(got?.evidence.length).toBeGreaterThanOrEqual(2)
  })
})
