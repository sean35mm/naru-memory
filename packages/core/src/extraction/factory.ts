/**
 * Extractor factory (plan §6.2, §13.2/§13.3).
 *
 * Maps a {@link LlmConfig} to a concrete {@link ExtractorProvider}, or `null`
 * when no provider is configured. A `null` extractor means extraction is
 * UNAVAILABLE — the `add --infer=false` manual path stays the only ingestion
 * route (plan §13.3), and `status` should report `extractor: unavailable`.
 *
 * - `mock`                  => deterministic offline {@link MockExtractor}
 * - `openai-compat` / `ollama` => {@link OpenAICompatExtractor}
 * - `none` / unset          => `null`
 */
import type { LlmConfig } from '../config'
import { MockExtractor } from './providers/mock'
import { type FetchImpl, OpenAICompatExtractor } from './providers/openai-compat'
import type { ExtractorProvider } from './types'

/** Default OpenAI-compatible base URL (Ollama's local OpenAI-compat server). */
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434'
/** Default model when an OpenAI-compatible provider omits one. */
const DEFAULT_OPENAI_COMPAT_MODEL = 'llama3.1'

/** Optional overrides for {@link createExtractor} (e.g. inject fetch in tests). */
export interface CreateExtractorOptions {
  /** Injected fetch for the OpenAI-compatible provider (defaults to global). */
  fetchImpl?: FetchImpl
}

/**
 * Build an {@link ExtractorProvider} from config, or `null` when unconfigured.
 *
 * Provider-agnostic: `ollama` is treated as an OpenAI-compatible endpoint
 * (Ollama exposes `/v1/chat/completions`). When the OpenAI-compatible base URL
 * or model is omitted, sensible local defaults are used.
 */
export function createExtractor(
  config: LlmConfig | undefined,
  options: CreateExtractorOptions = {},
): ExtractorProvider | null {
  if (!config) {
    return null
  }
  switch (config.provider) {
    case 'mock':
      return new MockExtractor()
    case 'openai-compat':
    case 'ollama': {
      const openaiConfig: ConstructorParameters<typeof OpenAICompatExtractor>[0] = {
        baseUrl: config.baseUrl ?? DEFAULT_OPENAI_COMPAT_BASE_URL,
        model: config.model ?? DEFAULT_OPENAI_COMPAT_MODEL,
        name: config.provider,
      }
      if (config.apiKey) {
        openaiConfig.apiKey = config.apiKey
      }
      if (options.fetchImpl) {
        openaiConfig.fetchImpl = options.fetchImpl
      }
      return new OpenAICompatExtractor(openaiConfig)
    }
    default:
      return null
  }
}
