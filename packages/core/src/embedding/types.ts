/**
 * Embedder provider contract (plan §6.2, §11.9, M3 vector retrieval).
 *
 * Providers are PROVIDER-AGNOSTIC: a deterministic offline {@link MockEmbedder}
 * (default/test backend, no network) and an OpenAI-compatible HTTP adapter sit
 * behind this one interface. Vector retrieval is OFF when no provider is
 * configured (`createEmbedder` returns `null`) and search degrades gracefully to
 * BM25/entity/recency (plan §6.2).
 *
 * PRIVACY (plan §18.1): like the extractor, an embedder may reach a remote
 * endpoint, so callers MUST redact text before embedding it.
 */
export interface EmbedderProvider {
  /** Provider name reported in capability/status surfaces (e.g. `mock`). */
  readonly name: string
  /**
   * Embedding model identifier (e.g. `nomic-embed-text`, `text-embedding-3-small`).
   *
   * Distinct from {@link name}, which is the provider. Persisted per stored
   * vector so KNN/reindex can target a specific model: two same-dimension models
   * on one provider must never silently mix in cosine ranking (plan §11.9).
   */
  readonly model: string
  /** Fixed output dimension every returned vector has. */
  readonly dimension: number
  /**
   * Embed a batch of texts, returning one L2-normalized `Float32Array` per
   * input in order. Each vector has length {@link dimension}.
   */
  embed(texts: string[]): Promise<Float32Array[]>
}
