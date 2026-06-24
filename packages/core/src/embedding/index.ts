/** Public embedding API barrel (plan §6.2, §11.9, M3 vector retrieval). */
export * from './types'
export * from './factory'
export * from './capability'
export { MockEmbedder, MOCK_EMBED_DIMENSION } from './providers/mock'
export {
  type OpenAICompatEmbedderConfig,
  EmbedderRequestError,
  OpenAICompatEmbedder,
} from './providers/openai-compat'
// `FetchImpl` is intentionally NOT re-exported here: it is structurally identical
// to the extraction layer's `FetchImpl`, which the package barrel already exports.
// Re-exporting it under the same name would make the top-level export ambiguous
// (TS2308). Import it from the extraction barrel, or from the embedder module path.
