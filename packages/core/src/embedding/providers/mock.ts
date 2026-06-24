/**
 * Deterministic offline embedder (plan §6.2, M3 default/test backend).
 *
 * MockEmbedder makes NO network calls and uses NO randomness: identical input
 * always yields an identical vector. It is the offline default and the
 * deterministic backend for tests, sized to a small fixed dimension (64).
 *
 * Method: tokenize into lowercased word/number runs, then hash each token into
 * the fixed-dimension space — each token contributes to a bucket chosen by a
 * deterministic hash, with a deterministic +/-1 sign (a second hash bit) so
 * different tokens do not all push in the same direction. The accumulated vector
 * is L2-normalized. Consequence (the property the layer relies on): texts that
 * share more tokens land in the same buckets with the same signs, so their
 * cosine similarity is higher than that of texts sharing fewer/no tokens.
 *
 * This is a bag-of-tokens hashing embedding (the "hashing trick"); it captures
 * lexical overlap, not deep semantics, which is exactly what a deterministic
 * offline/test backend needs.
 */
import type { EmbedderProvider } from '../types'

/** Fixed, small embedding dimension for the deterministic mock (plan task A). */
export const MOCK_EMBED_DIMENSION = 64

/** FNV-1a 32-bit hash of a string — deterministic, no dependencies. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 32-bit FNV prime multiply via shifts, kept in uint32 range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/** Lowercased Unicode word/number tokens (matches the FTS tokenization style). */
function tokenize(text: string): string[] {
  const matched = text
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
  return matched ?? []
}

export class MockEmbedder implements EmbedderProvider {
  readonly name = 'mock'
  /** Model identity for the mock (provider `mock`, dimension-tagged for the seam). */
  readonly model = `mock-${MOCK_EMBED_DIMENSION}`
  readonly dimension = MOCK_EMBED_DIMENSION

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text))
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimension)
    for (const token of tokenize(text)) {
      const h = fnv1a(token)
      const bucket = h % this.dimension
      // Use a separate bit of the hash for the sign so distinct tokens that
      // collide on a bucket can still partially cancel rather than always add.
      const sign = (h & 0x100) === 0 ? 1 : -1
      vec[bucket] = (vec[bucket] ?? 0) + sign
    }
    return l2normalize(vec)
  }
}

/** L2-normalize in place and return the same array; a zero vector is left as-is. */
function l2normalize(vec: Float32Array): Float32Array {
  let sumSq = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0
    sumSq += v * v
  }
  if (sumSq === 0) {
    return vec
  }
  const inv = 1 / Math.sqrt(sumSq)
  for (let i = 0; i < vec.length; i++) {
    vec[i] = (vec[i] ?? 0) * inv
  }
  return vec
}
