/**
 * Deterministic offline extractor (plan §6.2, §13.3 fallback / test backend).
 *
 * MockExtractor makes NO network calls and uses NO randomness: identical input
 * always yields identical output. It splits the input into sentence-level
 * memories, derives a naive (subject, predicate, object) triple, and computes
 * evidence spans as real offsets into the input text. It is the offline default
 * and the deterministic backend for tests.
 *
 * `reconcile` implements the simple semantic-tier rules:
 * - identical normalized statement  => duplicate(targetFactId)
 * - same subject+predicate, different object => supersedes(targetFactId)
 * - otherwise => new
 */
import { normalizeText } from '@naru/schema'
import type {
  ExtractedFact,
  ExtractorInput,
  ExtractorProvider,
  ReconcileDecision,
  ReconcileInput,
} from '../types'

/** Fixed confidence for mock-extracted facts (deterministic, no randomness). */
const MOCK_CONFIDENCE = 0.5

/** Sentence terminators used to segment the input into candidate memories. */
const SENTENCE_BOUNDARY = /[.!?]+/

/** A sentence segment with its absolute offsets into the source text. */
interface Segment {
  text: string
  start: number
  end: number
}

/**
 * Split `text` into trimmed sentence segments, preserving absolute character
 * offsets into the original input so evidence spans are real and stable.
 */
function segment(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const piece of text.split(SENTENCE_BOUNDARY)) {
    const rawStart = cursor
    cursor += piece.length + 1 // +1 approximates the consumed terminator
    const leading = piece.length - piece.trimStart().length
    const trimmed = piece.trim()
    if (trimmed.length === 0) {
      continue
    }
    const start = rawStart + leading
    segments.push({ text: trimmed, start, end: start + trimmed.length })
  }
  return segments
}

/**
 * Derive a naive (subject, predicate, object) triple from a sentence.
 *
 * Heuristic and deterministic: the first token is the subject, the second is
 * the predicate, and the remainder is the object. Degenerate sentences fall
 * back to a stable placeholder so the triple is always well-formed.
 */
function deriveTriple(sentence: string): {
  subject: string
  predicate: string
  object: string
} {
  const tokens = sentence.split(/\s+/u).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { subject: 'subject', predicate: 'is', object: sentence }
  }
  const subject = tokens[0] ?? 'subject'
  if (tokens.length === 1) {
    return { subject, predicate: 'is', object: subject }
  }
  const predicate = tokens[1] ?? 'is'
  const object = tokens.slice(2).join(' ') || predicate
  return { subject, predicate, object }
}

/** Capitalized proper-noun-ish tokens, used as a deterministic entity guess. */
function deriveEntities(sentence: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of sentence.split(/\s+/u)) {
    const word = token.replace(/[^\p{L}\p{N}]/gu, '')
    if (word.length === 0) {
      continue
    }
    const first = word[0] ?? ''
    if (first === first.toUpperCase() && first !== first.toLowerCase()) {
      const key = word.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(word)
      }
    }
  }
  return out
}

export class MockExtractor implements ExtractorProvider {
  readonly name = 'mock'

  async extract(input: ExtractorInput): Promise<ExtractedFact[]> {
    return segment(input.text).map((seg) => {
      const { subject, predicate, object } = deriveTriple(seg.text)
      return {
        subject,
        predicate,
        object,
        statement: seg.text,
        entities: deriveEntities(seg.text),
        confidence: MOCK_CONFIDENCE,
        valid_from: null,
        valid_to: null,
        evidence: {
          quote: seg.text,
          span_start: seg.start,
          span_end: seg.end,
        },
        linked_fact_ids: [],
      }
    })
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileDecision> {
    const candidateStatement = normalizeText(input.candidate.statement).toLowerCase()
    const candidateSubject = normalizeText(input.candidate.subject).toLowerCase()
    const candidatePredicate = normalizeText(input.candidate.predicate).toLowerCase()
    const candidateObject = normalizeText(input.candidate.object).toLowerCase()

    // 1) Identical normalized statement => duplicate.
    for (const rel of input.related) {
      if (normalizeText(rel.statement).toLowerCase() === candidateStatement) {
        return { kind: 'duplicate', targetFactId: rel.id, reason: 'identical statement' }
      }
    }

    // 2) Same subject+predicate, different object => supersedes the match.
    for (const rel of input.related) {
      const triple = deriveTriple(rel.statement)
      const relSubject = normalizeText(triple.subject).toLowerCase()
      const relPredicate = normalizeText(triple.predicate).toLowerCase()
      const relObject = normalizeText(triple.object).toLowerCase()
      if (
        relSubject === candidateSubject &&
        relPredicate === candidatePredicate &&
        relObject !== candidateObject
      ) {
        return {
          kind: 'supersedes',
          targetFactId: rel.id,
          reason: 'same subject/predicate, changed object',
        }
      }
    }

    // 3) Otherwise additive.
    return { kind: 'new' }
  }
}
