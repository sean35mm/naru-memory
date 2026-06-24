/**
 * Embedder factory (plan §6.2, §11.9, M3).
 *
 * Maps an {@link EmbeddingsConfig} to a concrete {@link EmbedderProvider}, or
 * `null` when no provider is configured. A `null` embedder means vector
 * retrieval is OFF — search degrades gracefully to BM25/entity/recency (plan
 * §6.2), and capability detection reports `embedder: { available: false }`.
 *
 * - `mock`                      => deterministic offline {@link MockEmbedder}
 * - `openai-compat` / `ollama`  => {@link OpenAICompatEmbedder}
 * - `none` / unset              => `null`
 */
import type { EmbeddingsConfig } from '../config'
import { MockEmbedder } from './providers/mock'
import { type FetchImpl, OpenAICompatEmbedder } from './providers/openai-compat'
import type { EmbedderProvider } from './types'

/** Default OpenAI-compatible base URL (Ollama's local OpenAI-compat server). */
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434'
/** Default embedding model when an OpenAI-compatible provider omits one. */
const DEFAULT_OPENAI_COMPAT_MODEL = 'nomic-embed-text'
/**
 * Default declared dimension for the OpenAI-compatible embedder when none is
 * given (matches `nomic-embed-text` / `text-embedding-3-small`). The adapter
 * validates returned vectors against this, so a mismatch surfaces loudly rather
 * than silently corrupting the index.
 */
const DEFAULT_OPENAI_COMPAT_DIMENSION = 768

/** Optional overrides for {@link createEmbedder} (e.g. inject fetch in tests). */
export interface CreateEmbedderOptions {
  /** Injected fetch for the OpenAI-compatible provider (defaults to global). */
  fetchImpl?: FetchImpl
  /** Override the declared dimension for the OpenAI-compatible provider. */
  dimension?: number
}

/**
 * Build an {@link EmbedderProvider} from config, or `null` when unconfigured.
 *
 * Provider-agnostic: `ollama` is treated as an OpenAI-compatible endpoint
 * (Ollama exposes `/v1/embeddings`). When the OpenAI-compatible base URL, model,
 * or dimension is omitted, sensible local defaults are used.
 */
export function createEmbedder(
  config: EmbeddingsConfig | undefined,
  options: CreateEmbedderOptions = {},
): EmbedderProvider | null {
  if (!config) {
    return null
  }
  switch (config.provider) {
    case 'mock':
      return new MockEmbedder()
    case 'openai-compat':
    case 'ollama': {
      const embedderConfig: ConstructorParameters<typeof OpenAICompatEmbedder>[0] = {
        baseUrl: config.baseUrl ?? DEFAULT_OPENAI_COMPAT_BASE_URL,
        model: config.model ?? DEFAULT_OPENAI_COMPAT_MODEL,
        dimension: options.dimension ?? DEFAULT_OPENAI_COMPAT_DIMENSION,
        name: config.provider,
      }
      if (config.apiKey) {
        embedderConfig.apiKey = config.apiKey
      }
      if (options.fetchImpl) {
        embedderConfig.fetchImpl = options.fetchImpl
      }
      return new OpenAICompatEmbedder(embedderConfig)
    }
    default:
      return null
  }
}
