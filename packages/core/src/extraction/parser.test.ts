import { describe, expect, it } from 'vitest'
import { parseExtraction, parseReconcile } from './parser'

describe('parseExtraction', () => {
  it('parses a clean valid JSON object', () => {
    const raw = JSON.stringify({
      facts: [
        {
          subject: 'User',
          predicate: 'prefers',
          object: 'dark mode',
          statement: 'User prefers dark mode for developer tools.',
          entities: ['User', 'dark mode'],
          confidence: 0.86,
          valid_from: null,
          valid_to: null,
          evidence: { quote: 'I prefer dark mode', span_start: 0, span_end: 18 },
          linked_fact_ids: [],
        },
      ],
    })
    const facts = parseExtraction(raw)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.subject).toBe('User')
    expect(facts[0]?.statement).toBe('User prefers dark mode for developer tools.')
    expect(facts[0]?.confidence).toBeCloseTo(0.86)
    expect(facts[0]?.evidence.span_end).toBe(18)
  })

  it('parses JSON wrapped in a ```json fence with surrounding prose', () => {
    const raw = [
      'Sure! Here are the facts I extracted:',
      '```json',
      JSON.stringify({
        facts: [
          {
            subject: 'User',
            predicate: 'uses',
            object: 'Vitest',
            statement: 'User uses Vitest for testing.',
            entities: ['Vitest'],
            confidence: 0.9,
            valid_from: null,
            valid_to: null,
            evidence: { quote: 'uses Vitest', span_start: 5, span_end: 16 },
            linked_fact_ids: [],
          },
        ],
      }),
      '```',
      'Let me know if you need anything else.',
    ].join('\n')
    const facts = parseExtraction(raw)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.object).toBe('Vitest')
  })

  it('accepts a bare top-level array', () => {
    const raw = JSON.stringify([
      {
        subject: 'User',
        predicate: 'is',
        object: 'engineer',
        statement: 'User is an engineer.',
        entities: [],
        confidence: 0.7,
        valid_from: null,
        valid_to: null,
        evidence: { quote: 'engineer', span_start: 0, span_end: 8 },
        linked_fact_ids: [],
      },
    ])
    const facts = parseExtraction(raw)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.statement).toBe('User is an engineer.')
  })

  it('drops invalid items but keeps the valid subset', () => {
    const raw = JSON.stringify({
      facts: [
        { subject: 'User', predicate: 'no', object: 'statement' }, // missing statement => dropped
        {
          subject: 'User',
          predicate: 'prefers',
          object: 'tabs',
          statement: 'User prefers tabs.',
          // missing optional arrays / evidence => coerced to safe defaults
        },
      ],
    })
    const facts = parseExtraction(raw)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.statement).toBe('User prefers tabs.')
    expect(facts[0]?.entities).toEqual([])
    expect(facts[0]?.linked_fact_ids).toEqual([])
    expect(facts[0]?.evidence).toEqual({ quote: '', span_start: 0, span_end: 0 })
    expect(facts[0]?.confidence).toBe(0.5)
  })

  it('coerces a string confidence and clamps out-of-range values', () => {
    const raw = JSON.stringify({
      facts: [
        {
          subject: 'a',
          predicate: 'b',
          object: 'c',
          statement: 'high conf',
          confidence: '2.5',
        },
        {
          subject: 'a',
          predicate: 'b',
          object: 'c',
          statement: 'neg conf',
          confidence: -1,
        },
      ],
    })
    const facts = parseExtraction(raw)
    expect(facts[0]?.confidence).toBe(1)
    expect(facts[1]?.confidence).toBe(0)
  })

  it('returns [] for garbage / non-JSON input', () => {
    expect(parseExtraction('this is not json at all')).toEqual([])
    expect(parseExtraction('')).toEqual([])
    expect(parseExtraction('{ broken json ]')).toEqual([])
    expect(parseExtraction('{"facts": "not-an-array"}')).toEqual([])
  })

  it('never throws on a malformed response', () => {
    expect(() => parseExtraction('```json\n{ nope')).not.toThrow()
    expect(() => parseExtraction('null')).not.toThrow()
    expect(() => parseExtraction('42')).not.toThrow()
  })
})

describe('parseReconcile', () => {
  it('parses a duplicate decision with a target', () => {
    const raw = JSON.stringify({
      kind: 'duplicate',
      target_fact_id: 'fact-1',
      reason: 'same meaning',
    })
    expect(parseReconcile(raw)).toEqual({
      kind: 'duplicate',
      targetFactId: 'fact-1',
      reason: 'same meaning',
    })
  })

  it('parses a supersedes decision wrapped in a fence', () => {
    const raw = '```json\n{ "kind": "supersedes", "target_fact_id": "fact-7" }\n```'
    expect(parseReconcile(raw)).toEqual({ kind: 'supersedes', targetFactId: 'fact-7' })
  })

  it('parses a new decision (no target)', () => {
    const raw = JSON.stringify({ kind: 'new', target_fact_id: null })
    expect(parseReconcile(raw)).toEqual({ kind: 'new' })
  })

  it('degrades duplicate/supersedes without a target to new', () => {
    expect(parseReconcile('{"kind":"supersedes","target_fact_id":null}')).toEqual({ kind: 'new' })
    expect(parseReconcile('{"kind":"duplicate"}')).toEqual({ kind: 'new' })
  })

  it('falls back to new for unknown kind or garbage, never throwing', () => {
    expect(parseReconcile('{"kind":"banana"}')).toEqual({ kind: 'new' })
    expect(parseReconcile('not json')).toEqual({ kind: 'new' })
    expect(() => parseReconcile('')).not.toThrow()
  })
})
