import { describe, expect, it } from 'vitest'
import { detectVectorCapability } from './capability'
import { createEmbedder } from './factory'
import { MOCK_EMBED_DIMENSION, MockEmbedder } from './providers/mock'
import { OpenAICompatEmbedder } from './providers/openai-compat'

describe('createEmbedder', () => {
  it('returns null when config is undefined (vector retrieval OFF)', () => {
    expect(createEmbedder(undefined)).toBeNull()
  })

  it("returns null for provider 'none'", () => {
    expect(createEmbedder({ provider: 'none' })).toBeNull()
  })

  it("builds a MockEmbedder for provider 'mock'", () => {
    const embedder = createEmbedder({ provider: 'mock' })
    expect(embedder).toBeInstanceOf(MockEmbedder)
    expect(embedder?.dimension).toBe(MOCK_EMBED_DIMENSION)
  })

  it("builds an OpenAICompatEmbedder for 'openai-compat' and 'ollama'", () => {
    const a = createEmbedder({ provider: 'openai-compat', baseUrl: 'http://h', model: 'm' })
    const b = createEmbedder({ provider: 'ollama' })
    expect(a).toBeInstanceOf(OpenAICompatEmbedder)
    expect(b).toBeInstanceOf(OpenAICompatEmbedder)
    expect(a?.name).toBe('openai-compat')
    expect(b?.name).toBe('ollama')
  })

  it('honors a dimension override for the OpenAI-compatible provider', () => {
    const embedder = createEmbedder({ provider: 'openai-compat' }, { dimension: 1536 })
    expect(embedder?.dimension).toBe(1536)
  })
})

describe('detectVectorCapability', () => {
  it('reports backend bruteforce and embedder unavailable when null', () => {
    expect(detectVectorCapability(null)).toEqual({
      backend: 'bruteforce',
      embedder: { available: false },
    })
  })

  it('reports the embedder provider + dimension when configured', () => {
    const cap = detectVectorCapability(new MockEmbedder(), { model: 'mock-model' })
    expect(cap.backend).toBe('bruteforce')
    expect(cap.embedder).toEqual({
      available: true,
      provider: 'mock',
      dimension: MOCK_EMBED_DIMENSION,
      model: 'mock-model',
    })
  })

  it('omits model when not supplied', () => {
    const cap = detectVectorCapability(new MockEmbedder())
    expect(cap.embedder).toEqual({
      available: true,
      provider: 'mock',
      dimension: MOCK_EMBED_DIMENSION,
    })
  })
})
