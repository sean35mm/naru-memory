import { describe, expect, it } from 'vitest'
import { MOCK_EMBED_DIMENSION, MockEmbedder } from './mock'

/** Cosine similarity of two equal-length vectors (test helper). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) {
    return 0
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function l2norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0
    s += x * x
  }
  return Math.sqrt(s)
}

describe('MockEmbedder', () => {
  const embedder = new MockEmbedder()

  it('reports a fixed small dimension and produces vectors of that length', async () => {
    expect(embedder.dimension).toBe(MOCK_EMBED_DIMENSION)
    const [vec] = await embedder.embed(['hello world'])
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec?.length).toBe(MOCK_EMBED_DIMENSION)
  })

  it('is deterministic: identical input yields an identical vector (no randomness)', async () => {
    const [a] = await embedder.embed(['User prefers dark mode for developer tools.'])
    const [b] = await new MockEmbedder().embed(['User prefers dark mode for developer tools.'])
    expect(Array.from(a ?? [])).toEqual(Array.from(b ?? []))
  })

  it('L2-normalizes non-empty vectors to unit length', async () => {
    const [vec] = await embedder.embed(['vitest testing framework'])
    expect(l2norm(vec ?? new Float32Array())).toBeCloseTo(1, 5)
  })

  it('ranks similar text higher than dissimilar text by cosine', async () => {
    const [base, similar, dissimilar] = await embedder.embed([
      'the user prefers vitest for testing',
      'the user prefers vitest as a testing framework',
      'deploy the kubernetes cluster to production region',
    ])
    const simScore = cosine(base ?? new Float32Array(), similar ?? new Float32Array())
    const disScore = cosine(base ?? new Float32Array(), dissimilar ?? new Float32Array())
    expect(simScore).toBeGreaterThan(disScore)
  })

  it('gives identical texts cosine ~1 and token-disjoint texts a lower score', async () => {
    const [x, xCopy, y] = await embedder.embed([
      'alpha beta gamma',
      'alpha beta gamma',
      'delta epsilon zeta',
    ])
    expect(cosine(x ?? new Float32Array(), xCopy ?? new Float32Array())).toBeCloseTo(1, 5)
    expect(cosine(x ?? new Float32Array(), y ?? new Float32Array())).toBeLessThan(1)
  })

  it('embeds a batch in input order with one vector per text', async () => {
    const vectors = await embedder.embed(['one', 'two', 'three'])
    expect(vectors).toHaveLength(3)
    // Order-stability: embedding the same batch again matches element-wise.
    const again = await embedder.embed(['one', 'two', 'three'])
    for (let i = 0; i < vectors.length; i++) {
      expect(Array.from(vectors[i] ?? [])).toEqual(Array.from(again[i] ?? []))
    }
  })

  it('returns a (zero) vector for empty/symbol-only text without throwing', async () => {
    const [empty] = await embedder.embed(['   !!!  '])
    expect(empty?.length).toBe(MOCK_EMBED_DIMENSION)
    expect(l2norm(empty ?? new Float32Array())).toBe(0)
  })
})
