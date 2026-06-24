import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Offline fallback (plan §13.3). With no extractor configured, capture must NOT
 * fail: it stores the redacted episode and falls back to a single manual fact,
 * and status reports the extractor as unavailable.
 */
describe('captureAndExtract fallback (plan §13.3)', () => {
  let naru: Naru

  beforeEach(() => {
    // No `llm` config -> extractor unavailable.
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('stores the redacted episode and a manual fact without throwing', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const text = 'We use trunk-based development on this project.'

    const { episode, facts } = await naru.capture({ text, scope })

    // The episode is stored with the redacted body.
    expect(episode.id).toMatch(/^ep_/)
    expect(episode.redactedText).toBe(text)

    // A single manual fact is created (infer=false behavior) and indexed.
    expect(facts).toHaveLength(1)
    expect(facts[0]?.statement).toBe(text)
    expect(facts[0]?.status).toBe('active')

    const got = naru.get(facts[0]?.id ?? '')
    expect(got?.evidence).toHaveLength(1)
    expect(got?.evidence[0]?.extractorName).toBe('manual')

    // It is retrievable via search.
    const hits = naru.search({ query: 'trunk', scope }).map((r) => r.factId)
    expect(hits).toContain(facts[0]?.id)
  })

  it('status reports extractor unavailable when none is configured', () => {
    expect(naru.status().features.extractor).toEqual({ available: false })
  })

  it('status reports the provider when an extractor is configured', () => {
    const withMock = Naru.open({ db: ':memory:', llm: { provider: 'mock', model: 'mock-1' } })
    try {
      expect(withMock.status().features.extractor).toEqual({
        available: true,
        provider: 'mock',
        model: 'mock-1',
      })
    } finally {
      withMock.close()
    }
  })

  it('does not throw and still stores the episode when the provider errors', async () => {
    // Configure a real openai-compat provider but inject no reachable endpoint;
    // the extract call will throw, exercising the catch-and-fallback path.
    const failing = Naru.open({
      db: ':memory:',
      llm: { provider: 'openai-compat', baseUrl: 'http://127.0.0.1:0', model: 'x' },
    })
    try {
      const scope = { type: 'project' as const, key: 'app' }
      const { episode, facts } = await failing.capture({ text: 'Fallback on error.', scope })
      expect(episode.redactedText).toBe('Fallback on error.')
      expect(facts).toHaveLength(1)
      expect(facts[0]?.statement).toBe('Fallback on error.')
    } finally {
      failing.close()
    }
  })
})
