import { z } from 'zod'

/**
 * Links a fact to the episode it was derived from (plan §11.6).
 *
 * Spans index into the episode's redacted text; `redactedQuote`/`quoteHash`
 * preserve the supporting snippet and a content hash for dedupe/provenance.
 */
export interface Evidence {
  id: string
  factId: string
  episodeId: string
  spanStart: number | null
  spanEnd: number | null
  redactedQuote: string | null
  quoteHash: string | null
  extractorName: string
  extractorVersion: string
  createdAt: string
}

export const EvidenceSchema: z.ZodType<Evidence> = z.object({
  id: z.string(),
  factId: z.string(),
  episodeId: z.string(),
  spanStart: z.number().int().nullable(),
  spanEnd: z.number().int().nullable(),
  redactedQuote: z.string().nullable(),
  quoteHash: z.string().nullable(),
  extractorName: z.string(),
  extractorVersion: z.string(),
  createdAt: z.string(),
})
