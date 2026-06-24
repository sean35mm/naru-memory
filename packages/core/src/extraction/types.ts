/**
 * Extraction-layer types (plan §13.2, §13.5, §13.6).
 *
 * These are the provider-facing contracts for the LLM extraction tier. They are
 * deliberately decoupled from the storage shapes in `@naru/schema`: a provider
 * emits {@link ExtractedFact}s (the typed JSON of plan §13.2), and the ingestion
 * layer is responsible for resolving entities, hashing, and persisting `Fact`s.
 *
 * PROVIDER POLICY: any provider that may reach a remote endpoint MUST be handed
 * text that has already been redacted (plan §18.1). Redaction is a
 * pre-extraction concern owned by the caller (episode capture redacts before
 * persistence); `ExtractorInput.text` is assumed to already be redacted.
 */

/** Supporting evidence for an extracted fact (plan §13.2). */
export interface ExtractedEvidence {
  /** Verbatim snippet from the (redacted) input supporting the fact. */
  quote: string
  /** Character offset of the quote within the input text. */
  span_start: number
  /** Character offset (exclusive) of the quote end within the input text. */
  span_end: number
}

/**
 * A single extracted candidate fact — the typed JSON shape of plan §13.2.
 *
 * Field names are snake_case to match the on-the-wire LLM JSON exactly; the
 * ingestion layer maps these onto the camelCase storage `Fact` shape.
 */
export interface ExtractedFact {
  /** Triple subject (e.g. "User"). */
  subject: string
  /** Triple predicate (e.g. "prefers"). */
  predicate: string
  /** Triple object (e.g. "dark mode"). */
  object: string
  /** Rich, self-contained human-readable memory. */
  statement: string
  /** Salient entity names mentioned (proper nouns, tools, people). */
  entities: string[]
  /** Extractor confidence in [0, 1]. */
  confidence: number
  /** Grounded validity start (ISO-8601) or null. */
  valid_from: string | null
  /** Grounded validity end (ISO-8601) or null. */
  valid_to: string | null
  /** Evidence reference into the input text. */
  evidence: ExtractedEvidence
  /** Extractor-suggested related existing fact ids (plan §13.5 dedup signal). */
  linked_fact_ids: string[]
}

/** Input to {@link ExtractorProvider.extract}. */
export interface ExtractorInput {
  /**
   * Source text to extract from. MUST already be redacted (plan §18.1) before
   * being handed to any provider that may talk to a remote endpoint.
   */
  text: string
  /** Observation timestamp (ISO-8601) used to ground relative dates (plan §13.2). */
  observedAt: string
  /** Optional scope key for prompt context (never authorizes cross-scope reads). */
  scopeKey?: string
  /**
   * Optional already-known context (e.g. nearby existing memories) the model may
   * use to avoid re-extracting duplicates. MUST also be redacted by the caller.
   */
  existingContext?: string
}

/** A semantic dedupe/supersession decision (plan §13.5, §13.6). */
export type ReconcileKind = 'duplicate' | 'new' | 'supersedes'

/** Input to {@link ExtractorProvider.reconcile}. */
export interface ReconcileInput {
  /** The newly extracted candidate under judgement. */
  candidate: ExtractedFact
  /** Related existing facts (id + human statement) to judge against. */
  related: { id: string; statement: string }[]
}

/**
 * Result of a reconcile judgement (plan §13.5 dedup, §13.6 supersession).
 *
 * - `duplicate`: candidate restates an existing fact; attach/ignore per policy.
 * - `supersedes`: candidate changes/conflicts with `targetFactId`; the
 *   ingestion layer inserts the new fact and supersedes the target.
 * - `new`: candidate is unrelated/additive; insert as a fresh fact.
 */
export interface ReconcileDecision {
  kind: ReconcileKind
  /** Required for `duplicate`/`supersedes`: the related fact id acted upon. */
  targetFactId?: string
  /** Optional short human-readable rationale (recorded as supersession reason). */
  reason?: string
}

/**
 * Provider contract for the LLM extraction tier (plan §6.2, §13.2).
 *
 * `extract` is required. `reconcile` is optional: when present it powers the
 * SEMANTIC dedupe/supersession tier (plan §13.5/§13.6); when absent the
 * ingestion layer falls back to exact-hash dedupe + manual supersession.
 */
export interface ExtractorProvider {
  /** Stable provider identifier, recorded as `evidence.extractorName`. */
  readonly name: string
  /** Extract candidate facts from (redacted) input text. */
  extract(input: ExtractorInput): Promise<ExtractedFact[]>
  /** Judge a candidate against related facts (semantic dedupe/supersession). */
  reconcile?(input: ReconcileInput): Promise<ReconcileDecision>
}
