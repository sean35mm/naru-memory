import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Golden extraction-driven ingestion test (plan §13). Uses the deterministic
 * MockExtractor (provider: 'mock'), so identical input yields identical facts
 * with real evidence spans — no network, no randomness.
 */
describe('captureAndExtract golden (plan §13.2)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', llm: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('extracts multiple evidence-backed facts from a two-sentence episode', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const text = 'We decided to use Vitest instead of Jest. The DB is Postgres 16.'

    const { episode, facts } = await naru.capture({ text, scope })

    // The episode was stored (redacted retention by default) with the source text.
    expect(episode.id).toMatch(/^ep_/)
    expect(episode.redactedText).toBe(text)

    // The MockExtractor segments on sentence boundaries -> two facts.
    expect(facts).toHaveLength(2)
    const statements = facts.map((f) => f.statement)
    expect(statements).toContain('We decided to use Vitest instead of Jest')
    expect(statements).toContain('The DB is Postgres 16')

    // Every fact is active and carries evidence with a redacted quote, a span,
    // a quote hash, and the provider's extractor name (plan §11.6).
    for (const fact of facts) {
      expect(fact.status).toBe('active')
      const got = naru.get(fact.id)
      expect(got).toBeDefined()
      expect(got?.evidence).toHaveLength(1)
      const ev = got?.evidence[0]
      expect(ev?.extractorName).toBe('mock')
      expect(ev?.redactedQuote).toBe(fact.statement)
      expect(ev?.quoteHash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof ev?.spanStart).toBe('number')
      expect(typeof ev?.spanEnd).toBe('number')
      expect((ev?.spanEnd ?? 0) > (ev?.spanStart ?? 0)).toBe(true)
    }

    // Facts are retrievable via scoped search and indexed into FTS.
    const hits = naru.search({ query: 'Postgres', scope }).map((r) => r.statement)
    expect(hits).toContain('The DB is Postgres 16')

    // Deterministic: identical input the second time creates no new facts.
    const second = await naru.capture({ text, scope })
    expect(second.facts.map((f) => f.id).sort()).toEqual(facts.map((f) => f.id).sort())
    expect(naru.list({ scope, status: 'active' })).toHaveLength(2)
  })
})
