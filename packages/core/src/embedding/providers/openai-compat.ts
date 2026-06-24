/**
 * OpenAI-compatible embeddings adapter (plan §6.2 local providers, M3).
 *
 * POSTs to any OpenAI-compatible `{baseUrl}/v1/embeddings` endpoint (Ollama's
 * OpenAI-compat server, LM Studio, vLLM, llama.cpp, OpenAI itself) via `fetch`.
 * The `fetchImpl` is INJECTABLE and defaults to the global `fetch`, so tests
 * stub it and NEVER hit the network.
 *
 * Request body: `{ model, input: string[] }`. Response: `{ data: [{ embedding:
 * number[] }, ...] }` in input order. Returned vectors are converted to
 * `Float32Array` and L2-normalized so cosine similarity is comparable across
 * providers (some endpoints already return normalized vectors; re-normalizing a
 * unit vector is a no-op).
 *
 * PRIVACY (plan §18.1): this adapter may reach a remote endpoint, so `texts`
 * MUST already be redacted by the caller.
 *
 * Robustness: non-2xx responses, malformed bodies, dimension mismatches, and
 * count mismatches raise {@link EmbedderRequestError} so the caller can degrade
 * to non-vector retrieval (plan §6.2) without crashing.
 */
import type { EmbedderProvider } from '../types'

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

/** Constructor configuration for {@link OpenAICompatEmbedder}. */
export interface OpenAICompatEmbedderConfig {
  /** Base URL of the server, e.g. `http://localhost:11434` (no trailing path). */
  baseUrl: string
  /** Embedding model identifier passed in the request body. */
  model: string
  /** Fixed output dimension this model produces (declared up front for the seam). */
  dimension: number
  /** Optional API key sent as `Authorization: Bearer <key>`. */
  apiKey?: string
  /** Injectable fetch; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
  /** Provider name reported as the embedder name; defaults to `openai-compat`. */
  name?: string
}

/** Typed error for failed/malformed embedding requests (callers catch this). */
export class EmbedderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmbedderRequestError'
  }
}

/** Minimal shape of an OpenAI-compatible embeddings response. */
interface EmbeddingsResponse {
  data?: { embedding?: number[] }[]
}

export class OpenAICompatEmbedder implements EmbedderProvider {
  readonly name: string
  /** Configured embedding model (e.g. `nomic-embed-text`); part of vector identity. */
  readonly model: string
  readonly dimension: number
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: FetchImpl

  constructor(config: OpenAICompatEmbedderConfig) {
    // Strip trailing slashes so we always build exactly `${base}/v1/embeddings`.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.model = config.model
    this.dimension = config.dimension
    this.apiKey = config.apiKey
    this.name = config.name ?? 'openai-compat'
    const injected = config.fetchImpl
    if (injected) {
      this.fetchImpl = injected
    } else if (typeof fetch === 'function') {
      this.fetchImpl = (input, init) => fetch(input, init)
    } else {
      throw new EmbedderRequestError('no fetch implementation available')
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return []
    }
    const url = `${this.baseUrl}/v1/embeddings`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }
    const body = JSON.stringify({ model: this.model, input: texts })

    let res: Awaited<ReturnType<FetchImpl>>
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body })
    } catch (err) {
      throw new EmbedderRequestError(
        `embedder request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new EmbedderRequestError(`embedder returned status ${res.status}`, res.status)
    }

    let raw: string
    try {
      raw = await res.text()
    } catch (err) {
      throw new EmbedderRequestError(
        `embedder response read failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    let parsed: EmbeddingsResponse
    try {
      parsed = JSON.parse(raw) as EmbeddingsResponse
    } catch {
      throw new EmbedderRequestError('embedder returned non-JSON response')
    }

    const data = parsed.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbedderRequestError(
        `embedder returned ${Array.isArray(data) ? data.length : 'no'} embeddings for ${texts.length} inputs`,
      )
    }

    return data.map((item, i) => {
      const embedding = item?.embedding
      if (!Array.isArray(embedding)) {
        throw new EmbedderRequestError(`embedder response item ${i} missing embedding array`)
      }
      if (embedding.length !== this.dimension) {
        throw new EmbedderRequestError(
          `embedder returned dimension ${embedding.length}, expected ${this.dimension}`,
        )
      }
      return l2normalize(Float32Array.from(embedding))
    })
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
