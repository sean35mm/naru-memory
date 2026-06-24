/**
 * Chat prompt construction for the LLM extraction tier (plan §13.2, §13.5/§13.6).
 *
 * `buildExtractionMessages` encodes the Mem0-borrowed extraction principles of
 * plan §13.2 into a system+user message pair that asks the model to return the
 * typed JSON of {@link import('./types').ExtractedFact}. `buildReconcileMessages`
 * asks the model to judge a candidate as duplicate / new / change (supersession).
 *
 * Prompts are provider-agnostic OpenAI-style chat messages so the same builder
 * feeds the mock and any OpenAI-compatible endpoint.
 */
import type { ExtractorInput, ReconcileInput } from './types'

/** A provider-agnostic OpenAI-style chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const EXTRACTION_SYSTEM = `You are a precise memory-extraction engine for a local-first personal memory system.

Read the provided text (which has already been redacted of secrets and sensitive PII) and extract durable, memorable information as structured facts. Follow these rules exactly:

- Extract memorable information, NOT the raw conversation. Capture standing facts, preferences, decisions, conventions, and stable attributes — not transient chatter.
- Preserve proper nouns, titles, exact dates, numbers, versions, and specific details verbatim.
- Ground relative dates ("yesterday", "next week", "last month") against the observation date provided by the user, and emit absolute ISO-8601 dates in valid_from / valid_to when a fact has a clear validity window. Otherwise use null.
- When a document or snippet is shared, extract the CONTENT of the document, not the meta-action of sharing it.
- Distinguish user-stated facts from assistant-generated suggestions/recommendations: only record what is asserted as true. Do not promote a mere suggestion into a stated preference.
- Skip greetings, filler, acknowledgments, and generic pleasantries.
- Prefer rich, self-contained memories over overly atomic fragments: each statement should stand on its own without surrounding context.
- NEVER fabricate. If something is not supported by the text, do not emit it.
- Include an evidence reference for every fact: a verbatim quote from the input plus its character offsets (span_start inclusive, span_end exclusive).

Return ONLY a single JSON object, with no prose and no markdown fences, of this exact shape:

{
  "facts": [
    {
      "subject": "string",
      "predicate": "string",
      "object": "string",
      "statement": "string",
      "entities": ["string"],
      "confidence": 0.0,
      "valid_from": null,
      "valid_to": null,
      "evidence": { "quote": "string", "span_start": 0, "span_end": 0 },
      "linked_fact_ids": []
    }
  ]
}

confidence is a number in [0,1]. entities and linked_fact_ids are arrays of strings (use [] when none). valid_from / valid_to are ISO-8601 strings or null. If there is nothing memorable, return {"facts": []}.`

const RECONCILE_SYSTEM = `You are a memory-reconciliation engine for a local-first personal memory system.

You are given a NEW candidate memory and a list of RELATED existing memories (each with an id). Decide how the candidate relates to the existing memories:

- "duplicate": the candidate restates information already captured by one related memory (same meaning, even if worded differently). Set target_fact_id to that memory's id.
- "supersedes": the candidate CHANGES or CONFLICTS with one related memory — the same subject/attribute now has a different value (e.g. switched tools, changed preference). Set target_fact_id to the memory it replaces.
- "new": the candidate is additive or unrelated to all related memories.

Return ONLY a single JSON object, no prose and no markdown fences, of this exact shape:

{ "kind": "duplicate" | "new" | "supersedes", "target_fact_id": "id-or-null", "reason": "short rationale" }

Use null for target_fact_id when kind is "new".`

/**
 * Build the system+user chat messages for fact extraction (plan §13.2).
 *
 * The user message carries the observation date (for relative-date grounding),
 * the optional scope key, optional existing context, and the source text.
 */
export function buildExtractionMessages(input: ExtractorInput): ChatMessage[] {
  const parts: string[] = [`Observation date (ISO-8601): ${input.observedAt}`]
  if (input.scopeKey) {
    parts.push(`Scope: ${input.scopeKey}`)
  }
  if (input.existingContext && input.existingContext.trim().length > 0) {
    parts.push(`Existing related memories (avoid re-extracting these):\n${input.existingContext}`)
  }
  parts.push(`Text to extract from:\n${input.text}`)
  return [
    { role: 'system', content: EXTRACTION_SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * Build the system+user chat messages for the reconcile judgement
 * (plan §13.5 dedup / §13.6 supersession).
 */
export function buildReconcileMessages(input: ReconcileInput): ChatMessage[] {
  const related = input.related.map((r) => `- id=${r.id}: ${r.statement}`).join('\n')
  const user = [
    `Candidate memory: ${input.candidate.statement}`,
    `Candidate triple: (${input.candidate.subject}, ${input.candidate.predicate}, ${input.candidate.object})`,
    `Related existing memories:\n${related.length > 0 ? related : '(none)'}`,
  ].join('\n\n')
  return [
    { role: 'system', content: RECONCILE_SYSTEM },
    { role: 'user', content: user },
  ]
}
