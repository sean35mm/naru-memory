/**
 * Tolerant parsing of LLM JSON into typed extraction results (plan §13.2).
 *
 * LLM output is untrusted text: it may be wrapped in ```json fences, prefixed
 * with prose, or partially malformed. `parseExtraction` / `parseReconcile` never
 * throw — they extract the first JSON object/array, validate it with zod, coerce
 * loose-but-recoverable shapes, drop invalid items, and return [] / a safe
 * default when nothing usable is present.
 */
import { z } from 'zod'
import type { ExtractedFact, ReconcileDecision, ReconcileKind } from './types'

/** Coerce a value into a finite number; non-numbers fail (handled by `.catch`). */
const numberLike = z.preprocess((v) => {
  if (typeof v === 'number') {
    return v
  }
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}, z.number())

/** Confidence in [0,1]; out-of-range / unparseable defaults to 0.5. */
const confidenceSchema = numberLike.transform((n) => Math.min(1, Math.max(0, n))).catch(0.5)

/** Integer offset; unparseable / negative defaults to 0. */
const spanSchema = numberLike
  .transform((n) => (Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0))
  .catch(0)

/** Array of strings, dropping non-string members; non-arrays default to []. */
const stringArraySchema = z
  .array(z.unknown())
  .transform((arr) => arr.filter((x): x is string => typeof x === 'string'))
  .catch([])

const nullableIsoSchema = z
  .union([z.string(), z.null()])
  .catch(null)
  .transform((v) => (typeof v === 'string' && v.trim().length > 0 ? v : null))

const evidenceSchema = z
  .object({
    quote: z.string().catch(''),
    span_start: spanSchema,
    span_end: spanSchema,
  })
  .catch({ quote: '', span_start: 0, span_end: 0 })

/**
 * A single extracted fact. `subject`/`predicate`/`object`/`statement` are
 * required strings — an item missing any of them is unrecoverable and is
 * dropped by the outer array filter (the item-level `.catch` returns null and
 * the array transform strips nulls).
 */
const factSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  statement: z.string().min(1),
  entities: stringArraySchema,
  confidence: confidenceSchema,
  valid_from: nullableIsoSchema,
  valid_to: nullableIsoSchema,
  evidence: evidenceSchema,
  linked_fact_ids: stringArraySchema,
})

/** Top-level extraction payload: `{ facts: [...] }`, dropping invalid items. */
const extractionSchema = z
  .object({
    facts: z
      .array(factSchema.nullable().catch(null))
      .transform((arr) => arr.filter((f): f is ExtractedFact => f !== null))
      .catch([]),
  })
  .catch({ facts: [] })

const RECONCILE_KINDS: ReconcileKind[] = ['duplicate', 'new', 'supersedes']

const reconcileSchema = z
  .object({
    kind: z.string(),
    target_fact_id: z.union([z.string(), z.null()]).catch(null),
    reason: z.union([z.string(), z.null()]).catch(null),
  })
  .catch({ kind: 'new', target_fact_id: null, reason: null })

/**
 * Extract the first balanced JSON object/array substring from raw LLM text.
 *
 * Handles ```json … ``` fences and surrounding prose by scanning for the first
 * `{`/`[` and matching its close while respecting strings/escapes. Returns the
 * candidate JSON string, or null if no plausible JSON is present.
 */
function extractJsonSubstring(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const haystack = fenceMatch?.[1] ?? raw

  const startObj = haystack.indexOf('{')
  const startArr = haystack.indexOf('[')
  const candidates = [startObj, startArr].filter((i) => i >= 0)
  if (candidates.length === 0) {
    return null
  }
  const start = Math.min(...candidates)
  const open = haystack[start]
  const close = open === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) {
        return haystack.slice(start, i + 1)
      }
    }
  }
  return null
}

/** Safely parse a JSON substring; returns undefined on any failure. */
function safeJsonParse(raw: string): unknown {
  const candidate = extractJsonSubstring(raw)
  if (candidate === null) {
    return undefined
  }
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

/**
 * Parse an LLM extraction response into {@link ExtractedFact}[].
 *
 * Tolerates fences, surrounding prose, and partial malformation. Never throws:
 * returns the valid subset, or [] when nothing usable is present.
 */
export function parseExtraction(raw: string): ExtractedFact[] {
  const data = safeJsonParse(raw)
  if (data === undefined) {
    return []
  }
  // Accept either { facts: [...] } or a bare [...] array.
  const wrapped = Array.isArray(data) ? { facts: data } : data
  return extractionSchema.parse(wrapped).facts
}

/**
 * Parse an LLM reconcile response into a {@link ReconcileDecision}.
 *
 * Never throws: an unrecognized/missing `kind` or a `supersedes`/`duplicate`
 * without a usable `target_fact_id` safely degrades to `{ kind: 'new' }`.
 */
export function parseReconcile(raw: string): ReconcileDecision {
  const data = safeJsonParse(raw)
  if (data === undefined) {
    return { kind: 'new' }
  }
  const parsed = reconcileSchema.parse(data)
  const kind = RECONCILE_KINDS.includes(parsed.kind as ReconcileKind)
    ? (parsed.kind as ReconcileKind)
    : 'new'
  const targetFactId = parsed.target_fact_id ?? undefined
  const reason = parsed.reason ?? undefined

  // duplicate/supersedes require a target; without one the decision is unusable.
  if ((kind === 'duplicate' || kind === 'supersedes') && !targetFactId) {
    return { kind: 'new', reason }
  }
  const decision: ReconcileDecision = { kind }
  if (kind !== 'new' && targetFactId) {
    decision.targetFactId = targetFactId
  }
  if (reason) {
    decision.reason = reason
  }
  return decision
}
