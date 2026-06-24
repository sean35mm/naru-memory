import { Store } from '@naru/store-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtractedFact, ExtractorInput, ExtractorProvider } from './extraction'
import { MemoryService } from './memory-service'
import { ScopeService } from './scope-service'

/**
 * Redaction-before-extraction guarantee (plan §18.1). The extractor adapter may
 * reach a remote endpoint, so the text handed to it MUST already be redacted.
 * We inject a spy provider that records exactly what it received and assert the
 * secret never reaches it (nor the stored episode/facts).
 */
describe('redaction before extract (plan §18.1)', () => {
  let store: Store
  let memory: MemoryService
  let received: string[]

  /** Spy provider: records each `extract` input; emits one fact from the input. */
  const spy: ExtractorProvider = {
    name: 'spy',
    async extract(input: ExtractorInput): Promise<ExtractedFact[]> {
      received.push(input.text)
      return [
        {
          subject: 'config',
          predicate: 'has',
          object: 'token',
          statement: input.text,
          entities: [],
          confidence: 0.9,
          valid_from: null,
          valid_to: null,
          evidence: { quote: input.text, span_start: 0, span_end: input.text.length },
          linked_fact_ids: [],
        },
      ]
    },
  }

  beforeEach(() => {
    received = []
    store = Store.open({ path: ':memory:' })
    const scopeService = new ScopeService(store)
    memory = new MemoryService(store, scopeService, 'redacted', spy)
  })

  afterEach(() => {
    store.close()
  })

  it('the secret is redacted before reaching the extractor and is never stored', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    const secret = 'sk-abcdefABCDEF0123456789ghijklmnop'
    const text = `The deploy key is ${secret} and must be kept safe.`

    const { episode, facts } = await memory.captureAndExtract({ text, scope })

    // The spy was called exactly once, and what it received did NOT contain the
    // secret (it was redacted to a placeholder before extraction).
    expect(received).toHaveLength(1)
    expect(received[0]).toBeDefined()
    expect(received[0]).not.toContain(secret)
    expect(received[0]).toContain('[REDACTED:')

    // The stored episode body is redacted too.
    expect(episode.redactedText).not.toContain(secret)
    expect(episode.redactedText).toContain('[REDACTED:')

    // No stored fact statement (nor its evidence quote) leaks the secret.
    expect(facts.length).toBeGreaterThan(0)
    for (const fact of facts) {
      expect(fact.statement).not.toContain(secret)
      const got = memory.get(fact.id)
      for (const ev of got?.evidence ?? []) {
        expect(ev.redactedQuote ?? '').not.toContain(secret)
      }
    }
  })
})
