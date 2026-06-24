/**
 * Vector capability detection (plan §12.2, §15.2 `system.status`, M3 task C).
 *
 * Reports which vector backend is active and whether an embedder is available.
 * The backend is `bruteforce` now — in-JS cosine KNN over scope-filtered Float32
 * BLOBs (no native dependency). This function is the SEAM where an accelerated
 * backend (e.g. `sqlite-vec`) would be detected and reported instead; nothing
 * else needs to change to add one later (intentionally NOT added now).
 *
 * When no embedder is configured, vector retrieval is OFF and search degrades
 * gracefully to BM25/entity/recency (plan §6.2); `embedder.available` is false.
 */
import type { EmbedderProvider } from './types'

/** The only vector backend in M3: brute-force in-JS cosine KNN (plan §12.2). */
export type VectorBackend = 'bruteforce'

/** Embedder availability for capability/status surfaces. */
export type EmbedderCapability =
  | { available: false }
  | { available: true; provider: string; dimension: number; model?: string }

/** Vector subsystem capability snapshot (plan §15.2). */
export interface VectorCapability {
  /** Active KNN backend; `bruteforce` until an accelerated backend is added. */
  backend: VectorBackend
  /** Embedder availability + identity, or `{ available: false }` when OFF. */
  embedder: EmbedderCapability
}

/** Optional identity hints not derivable from the provider itself (e.g. model). */
export interface DetectVectorCapabilityOptions {
  /** Configured model name to surface when the provider doesn't expose one. */
  model?: string
}

/**
 * Detect the vector capability from the (optional) configured embedder.
 *
 * `backend` is always `bruteforce` in M3. `embedder` is `{ available: false }`
 * when `embedder` is `null` (vector retrieval OFF), otherwise reports the
 * provider name + fixed dimension (and model when supplied).
 */
export function detectVectorCapability(
  embedder: EmbedderProvider | null,
  options: DetectVectorCapabilityOptions = {},
): VectorCapability {
  if (!embedder) {
    return { backend: 'bruteforce', embedder: { available: false } }
  }
  const capability: EmbedderCapability = {
    available: true,
    provider: embedder.name,
    dimension: embedder.dimension,
  }
  if (options.model) {
    capability.model = options.model
  }
  return { backend: 'bruteforce', embedder: capability }
}
