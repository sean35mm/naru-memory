import { describe, expect, it, vi } from 'vitest'
import { ExtractorRequestError, type FetchImpl, OpenAICompatExtractor } from './openai-compat'

const observedAt = '2026-06-24T00:00:00.000Z'

/** Build a stub fetch returning a canned chat-completion body. */
function stubFetch(
  completionContent: string,
  status = 200,
): {
  fetchImpl: FetchImpl
  calls: { url: string; init?: Parameters<FetchImpl>[1] }[]
} {
  const calls: { url: string; init?: Parameters<FetchImpl>[1] }[] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ choices: [{ message: { content: completionContent } }] }),
    }
  }
  return { fetchImpl, calls }
}

describe('OpenAICompatExtractor.extract', () => {
  it('POSTs the right request shape and parses the response into facts', async () => {
    const completion = JSON.stringify({
      facts: [
        {
          subject: 'User',
          predicate: 'prefers',
          object: 'dark mode',
          statement: 'User prefers dark mode.',
          entities: ['User', 'dark mode'],
          confidence: 0.9,
          valid_from: null,
          valid_to: null,
          evidence: { quote: 'dark mode', span_start: 0, span_end: 9 },
          linked_fact_ids: [],
        },
      ],
    })
    const { fetchImpl, calls } = stubFetch(completion)
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      apiKey: 'secret-key',
      fetchImpl,
    })

    const facts = await extractor.extract({ text: 'I prefer dark mode', observedAt })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers?.authorization).toBe('Bearer secret-key')
    expect(call?.init?.headers?.['content-type']).toBe('application/json')

    const body = JSON.parse(call?.init?.body ?? '{}')
    expect(body.model).toBe('llama3.1')
    expect(body.temperature).toBe(0)
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
    // observedAt must reach the model for relative-date grounding.
    expect(body.messages[1]?.content).toContain(observedAt)
    expect(body.messages[1]?.content).toContain('I prefer dark mode')

    expect(facts).toHaveLength(1)
    expect(facts[0]?.statement).toBe('User prefers dark mode.')
  })

  it('strips a trailing slash from baseUrl and omits auth header without apiKey', async () => {
    const { fetchImpl, calls } = stubFetch('{"facts":[]}')
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:1234/',
      model: 'm',
      fetchImpl,
    })
    await extractor.extract({ text: 'hello', observedAt })
    expect(calls[0]?.url).toBe('http://localhost:1234/v1/chat/completions')
    expect(calls[0]?.init?.headers?.authorization).toBeUndefined()
  })

  it('never touches the real network (stub is the only call path)', async () => {
    const realFetch = vi.fn()
    // If the impl ignored the stub and used global fetch, this spy would fire.
    const { fetchImpl, calls } = stubFetch('{"facts":[]}')
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      fetchImpl,
    })
    await extractor.extract({ text: 'x', observedAt })
    expect(calls).toHaveLength(1)
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('throws a typed ExtractorRequestError on non-200', async () => {
    const { fetchImpl } = stubFetch('{}', 500)
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      fetchImpl,
    })
    await expect(extractor.extract({ text: 'x', observedAt })).rejects.toBeInstanceOf(
      ExtractorRequestError,
    )
    await expect(extractor.extract({ text: 'x', observedAt })).rejects.toMatchObject({
      status: 500,
    })
  })

  it('throws a typed error when the body is missing message content', async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{}] }),
    })
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      fetchImpl,
    })
    await expect(extractor.extract({ text: 'x', observedAt })).rejects.toBeInstanceOf(
      ExtractorRequestError,
    )
  })

  it('throws a typed error on a non-JSON response body', async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => 'not json',
    })
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      fetchImpl,
    })
    await expect(extractor.extract({ text: 'x', observedAt })).rejects.toBeInstanceOf(
      ExtractorRequestError,
    )
  })
})

describe('OpenAICompatExtractor.reconcile', () => {
  it('parses a reconcile decision from a canned completion', async () => {
    const completion = JSON.stringify({ kind: 'supersedes', target_fact_id: 'fact-3' })
    const { fetchImpl, calls } = stubFetch(completion)
    const extractor = new OpenAICompatExtractor({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      fetchImpl,
    })
    const decision = await extractor.reconcile({
      candidate: {
        subject: 'User',
        predicate: 'uses',
        object: 'Vitest',
        statement: 'User uses Vitest',
        entities: [],
        confidence: 0.5,
        valid_from: null,
        valid_to: null,
        evidence: { quote: '', span_start: 0, span_end: 0 },
        linked_fact_ids: [],
      },
      related: [{ id: 'fact-3', statement: 'User uses Jest' }],
    })
    expect(decision).toEqual({ kind: 'supersedes', targetFactId: 'fact-3' })
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
  })
})
