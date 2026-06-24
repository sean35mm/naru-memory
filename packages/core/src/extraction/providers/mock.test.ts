import { describe, expect, it } from 'vitest'
import type { ExtractedFact } from '../types'
import { MockExtractor } from './mock'

const observedAt = '2026-06-24T00:00:00.000Z'

function fact(partial: Partial<ExtractedFact>): ExtractedFact {
  return {
    subject: 'User',
    predicate: 'prefers',
    object: 'dark mode',
    statement: 'User prefers dark mode',
    entities: [],
    confidence: 0.5,
    valid_from: null,
    valid_to: null,
    evidence: { quote: '', span_start: 0, span_end: 0 },
    linked_fact_ids: [],
    ...partial,
  }
}

describe('MockExtractor.extract', () => {
  it('is deterministic: identical input yields identical output', async () => {
    const extractor = new MockExtractor()
    const input = {
      text: 'User prefers dark mode. User uses Vitest for testing.',
      observedAt,
    }
    const a = await extractor.extract(input)
    const b = await extractor.extract(input)
    expect(a).toEqual(b)
    expect(a).toHaveLength(2)
  })

  it('makes no network calls and produces fixed confidence', async () => {
    const extractor = new MockExtractor()
    const facts = await extractor.extract({ text: 'User likes coffee.', observedAt })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.confidence).toBe(0.5)
  })

  it('computes evidence spans as real offsets into the input', async () => {
    const extractor = new MockExtractor()
    const text = 'User prefers dark mode. User uses Vitest.'
    const facts = await extractor.extract({ text, observedAt })
    for (const f of facts) {
      const slice = text.slice(f.evidence.span_start, f.evidence.span_end)
      expect(slice).toBe(f.evidence.quote)
      expect(f.evidence.quote).toBe(f.statement)
    }
    // Second sentence's span starts after the first.
    expect(facts[1]?.evidence.span_start).toBeGreaterThan(facts[0]?.evidence.span_end ?? 0)
  })

  it('derives a well-formed subject/predicate/object triple', async () => {
    const extractor = new MockExtractor()
    const facts = await extractor.extract({ text: 'User prefers dark mode.', observedAt })
    expect(facts[0]?.subject).toBe('User')
    expect(facts[0]?.predicate).toBe('prefers')
    expect(facts[0]?.object).toBe('dark mode')
  })

  it('returns no facts for whitespace/filler-only input', async () => {
    const extractor = new MockExtractor()
    expect(await extractor.extract({ text: '   ', observedAt })).toEqual([])
    expect(await extractor.extract({ text: '...', observedAt })).toEqual([])
  })

  it('derives capitalized tokens as entities', async () => {
    const extractor = new MockExtractor()
    const facts = await extractor.extract({ text: 'User uses Vitest for testing.', observedAt })
    expect(facts[0]?.entities).toContain('User')
    expect(facts[0]?.entities).toContain('Vitest')
    expect(facts[0]?.entities).not.toContain('for')
  })
})

describe('MockExtractor.reconcile', () => {
  it('flags an identical normalized statement as a duplicate', async () => {
    const extractor = new MockExtractor()
    const decision = await extractor.reconcile({
      candidate: fact({ statement: 'User prefers dark mode' }),
      related: [{ id: 'fact-1', statement: 'user   PREFERS  dark mode' }],
    })
    expect(decision).toEqual({
      kind: 'duplicate',
      targetFactId: 'fact-1',
      reason: 'identical statement',
    })
  })

  it('supersedes when same subject+predicate but different object', async () => {
    const extractor = new MockExtractor()
    const decision = await extractor.reconcile({
      candidate: fact({
        subject: 'User',
        predicate: 'uses',
        object: 'Vitest',
        statement: 'User uses Vitest',
      }),
      related: [{ id: 'fact-9', statement: 'User uses Jest' }],
    })
    expect(decision.kind).toBe('supersedes')
    expect(decision.targetFactId).toBe('fact-9')
  })

  it('returns new when unrelated to all related facts', async () => {
    const extractor = new MockExtractor()
    const decision = await extractor.reconcile({
      candidate: fact({
        subject: 'User',
        predicate: 'likes',
        object: 'coffee',
        statement: 'User likes coffee',
      }),
      related: [{ id: 'fact-2', statement: 'Project deploys on Friday' }],
    })
    expect(decision).toEqual({ kind: 'new' })
  })

  it('is deterministic across repeated reconcile calls', async () => {
    const extractor = new MockExtractor()
    const input = {
      candidate: fact({ statement: 'User uses Vitest', predicate: 'uses', object: 'Vitest' }),
      related: [{ id: 'fact-9', statement: 'User uses Jest' }],
    }
    expect(await extractor.reconcile(input)).toEqual(await extractor.reconcile(input))
  })
})
