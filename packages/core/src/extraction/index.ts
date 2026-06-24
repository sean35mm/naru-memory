/** Public extraction API barrel (plan §13.2 extraction tier). */
export * from './types'
export * from './prompt'
export * from './parser'
export * from './factory'
export { MockExtractor } from './providers/mock'
export {
  type FetchImpl,
  type OpenAICompatConfig,
  ExtractorRequestError,
  OpenAICompatExtractor,
} from './providers/openai-compat'
