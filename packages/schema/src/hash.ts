import { createHash } from 'node:crypto'

/**
 * Version of the canonicalization + hashing rules.
 *
 * Bump this whenever the canonicalization rule changes so that old and new
 * hashes do not silently collide or miss across versions (plan §11.5).
 */
export const HASH_VERSION = 1 as const

/**
 * Normalize text for stable, portable hashing.
 *
 * - Unicode NFC normalization (canonical composition)
 * - trim leading/trailing whitespace
 * - collapse all internal whitespace runs to a single space
 *
 * Casefolding is applied separately by the statement/source canonicalizers so
 * that callers who only want whitespace/Unicode normalization can opt out.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/gu, ' ')
}

/** Lowercase + normalize for case-insensitive matching. */
function casefoldNormalize(s: string): string {
  // toLowerCase after NFC; normalize again so casefolding can't break composition.
  return normalizeText(normalizeText(s).toLowerCase())
}

/** SHA-256 hex digest of a UTF-8 string (plan §11.5). */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * Deterministically serialize a plain object with stable key order.
 *
 * Keys are sorted so the same logical content serializes identically across
 * machines regardless of insertion order. Used to build the pre-image for
 * content hashes.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

export interface StatementHashInput {
  /** Scope key as produced by `scopeKey(type, key)`. */
  scopeKey: string
  /** Subject reference, ideally a normalized entity key (not a raw ID). */
  subject?: string | null
  predicate: string
  /** Object reference: normalized entity key or literal value. */
  object?: string | null
}

/**
 * Portable content hash over a canonicalized statement (plan §11.5).
 *
 * Canonicalization: casefold + NFC + whitespace-collapse each field, build an
 * ordered object, prepend the HASH_VERSION, serialize with stable key order,
 * then sha256. Entity references should already be resolved to normalized keys
 * by the caller so the same fact hashes equally across stores.
 */
export function statementHash(input: StatementHashInput): string {
  const canonical = {
    v: HASH_VERSION,
    scopeKey: casefoldNormalize(input.scopeKey),
    subject: input.subject == null ? null : casefoldNormalize(input.subject),
    predicate: casefoldNormalize(input.predicate),
    object: input.object == null ? null : casefoldNormalize(input.object),
  }
  return sha256Hex(stableStringify(canonical))
}

export interface SourceHashInput {
  text: string
  sourceType: string
  sourceRef?: string | null
}

/**
 * Portable content hash over a (redacted) source plus its metadata (plan §11.5,
 * §11.3). Used for episode dedupe and provenance with the same canonicalization
 * discipline as `statementHash`.
 */
export function sourceHash(input: SourceHashInput): string {
  const canonical = {
    v: HASH_VERSION,
    text: normalizeText(input.text),
    sourceType: casefoldNormalize(input.sourceType),
    sourceRef: input.sourceRef == null ? null : normalizeText(input.sourceRef),
  }
  return sha256Hex(stableStringify(canonical))
}
