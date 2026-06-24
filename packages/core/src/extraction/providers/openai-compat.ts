/**
 * OpenAI-compatible chat extractor (plan §6.2 local providers).
 *
 * Talks to any OpenAI-compatible `/v1/chat/completions` endpoint (Ollama's
 * OpenAI-compat server, LM Studio, vLLM, etc.) via `fetch`. The `fetchImpl` is
 * injectable and defaults to the global `fetch` so tests can stub it and NEVER
 * hit the network.
 *
 * PROVIDER POLICY (plan §18.1): this adapter may reach a remote endpoint, so
 * `input.text` MUST already be redacted by the caller before extract/reconcile.
 *
 * Robustness: non-2xx responses and malformed bodies raise
 * {@link ExtractorRequestError}, a typed error the ingestion layer can catch to
 * fall back to the offline path (plan §13.3) without crashing capture.
 */
import { parseExtraction, parseReconcile } from '../parser'
import { type ChatMessage, buildExtractionMessages, buildReconcileMessages } from '../prompt'
import type {
  ExtractedFact,
  ExtractorInput,
  ExtractorProvider,
  ReconcileDecision,
  ReconcileInput,
} from '../types'

/** Minimal fetch signature so a stub need not reimplement the whole DOM type. */
export type FetchImpl = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** Constructor configuration for {@link OpenAICompatExtractor}. */
export interface OpenAICompatConfig {
  /** Base URL of the server, e.g. `http://localhost:11434` (no trailing path). */
  baseUrl: string
  /** Model identifier passed in the request body. */
  model: string
  /** Optional API key sent as `Authorization: Bearer <key>`. */
  apiKey?: string
  /** Injectable fetch; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
  /** Provider name reported as the extractor name; defaults to `openai-compat`. */
  name?: string
}

/** Typed error for failed/malformed extractor requests (ingestion catches this). */
export class ExtractorRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ExtractorRequestError'
  }
}

/** Minimal shape of an OpenAI-compatible chat completion response. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export class OpenAICompatExtractor implements ExtractorProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey?: string
  private readonly fetchImpl: FetchImpl

  constructor(config: OpenAICompatConfig) {
    // Strip trailing slashes so we always build exactly `${base}/v1/chat/completions`.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.model = config.model
    this.apiKey = config.apiKey
    this.name = config.name ?? 'openai-compat'
    const injected = config.fetchImpl
    if (injected) {
      this.fetchImpl = injected
    } else if (typeof fetch === 'function') {
      this.fetchImpl = (input, init) => fetch(input, init)
    } else {
      throw new ExtractorRequestError('no fetch implementation available')
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractedFact[]> {
    const content = await this.complete(buildExtractionMessages(input))
    return parseExtraction(content)
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileDecision> {
    const content = await this.complete(buildReconcileMessages(input))
    return parseReconcile(content)
  }

  /** POST the chat messages and return the first choice's message content. */
  private async complete(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    })

    let res: Awaited<ReturnType<FetchImpl>>
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body })
    } catch (err) {
      throw new ExtractorRequestError(
        `extractor request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new ExtractorRequestError(`extractor returned status ${res.status}`, res.status)
    }

    let raw: string
    try {
      raw = await res.text()
    } catch (err) {
      throw new ExtractorRequestError(
        `extractor response read failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    let parsed: ChatCompletionResponse
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse
    } catch {
      throw new ExtractorRequestError('extractor returned non-JSON response')
    }
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new ExtractorRequestError('extractor response missing choices[0].message.content')
    }
    return content
  }
}
