import { describe, expect, it, vi } from 'vitest'
import { EmbedderRequestError, type FetchImpl, OpenAICompatEmbedder } from './openai-compat'

/** Build a stub fetch returning a 200 JSON body; records calls. No network. */
function okFetch(body: unknown): { impl: FetchImpl; calls: { url: string; init?: unknown }[] } {
  const calls: { url: string; init?: unknown }[] = []
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  return { impl, calls }
}

const DIM = 3

describe('OpenAICompatEmbedder', () => {
  it('POSTs to {baseUrl}/v1/embeddings with model + input and parses data[].embedding', async () => {
    const { impl, calls } = okFetch({
      data: [{ embedding: [3, 0, 0] }, { embedding: [0, 4, 0] }],
    })
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://localhost:11434/',
      model: 'nomic-embed-text',
      dimension: DIM,
      apiKey: 'secret-key',
      fetchImpl: impl,
    })

    const vectors = await embedder.embed(['hello', 'world'])

    // Exactly one request, to the embeddings path (trailing slash stripped).
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/embeddings')
    const init = calls[0]?.init as {
      method?: string
      headers?: Record<string, string>
      body?: string
    }
    expect(init?.method).toBe('POST')
    expect(init?.headers?.authorization).toBe('Bearer secret-key')
    expect(init?.headers?.['content-type']).toBe('application/json')
    const sent = JSON.parse(init?.body ?? '{}')
    expect(sent.model).toBe('nomic-embed-text')
    expect(sent.input).toEqual(['hello', 'world'])

    // Parsed + L2-normalized in input order.
    expect(vectors).toHaveLength(2)
    expect(Array.from(vectors[0] ?? [])).toEqual([1, 0, 0])
    expect(Array.from(vectors[1] ?? [])).toEqual([0, 1, 0])
  })

  it('omits the Authorization header when no apiKey is configured', async () => {
    const { impl, calls } = okFetch({ data: [{ embedding: [1, 0, 0] }] })
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    await embedder.embed(['x'])
    const init = calls[0]?.init as { headers?: Record<string, string> }
    expect(init?.headers?.authorization).toBeUndefined()
  })

  it('does not call fetch for an empty batch', async () => {
    const impl = vi.fn<FetchImpl>()
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    const out = await embedder.embed([])
    expect(out).toEqual([])
    expect(impl).not.toHaveBeenCalled()
  })

  it('throws EmbedderRequestError on a non-2xx response', async () => {
    const impl: FetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' })
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    await expect(embedder.embed(['x'])).rejects.toBeInstanceOf(EmbedderRequestError)
  })

  it('throws on a non-JSON response body', async () => {
    const impl: FetchImpl = async () => ({ ok: true, status: 200, text: async () => 'not json' })
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    await expect(embedder.embed(['x'])).rejects.toBeInstanceOf(EmbedderRequestError)
  })

  it('throws when the embedding count does not match the input count', async () => {
    const { impl } = okFetch({ data: [{ embedding: [1, 0, 0] }] })
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    await expect(embedder.embed(['a', 'b'])).rejects.toBeInstanceOf(EmbedderRequestError)
  })

  it('throws when a returned embedding has the wrong dimension', async () => {
    const { impl } = okFetch({ data: [{ embedding: [1, 0] }] }) // dim 2, expected 3
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      fetchImpl: impl,
    })
    await expect(embedder.embed(['a'])).rejects.toBeInstanceOf(EmbedderRequestError)
  })

  it('reports its configured name and dimension', () => {
    const embedder = new OpenAICompatEmbedder({
      baseUrl: 'http://host',
      model: 'm',
      dimension: DIM,
      name: 'ollama',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    })
    expect(embedder.name).toBe('ollama')
    expect(embedder.dimension).toBe(DIM)
  })
})
