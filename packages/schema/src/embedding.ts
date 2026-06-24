import { z } from 'zod'

/**
 * Embedding lifecycle status. Types only — embeddings are a later milestone
 * (plan §11.9). This is a seam; no embedding logic lives here.
 */
export const EMBEDDING_STATUSES = ['pending', 'ready', 'stale', 'error'] as const

export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number]

export const EmbeddingStatusSchema = z.enum(EMBEDDING_STATUSES)

/**
 * Tracks embedding state for a target (plan §11.9). Actual vector storage may
 * live in SQLite/libSQL vector columns, side tables, or derived index tables
 * depending on driver capability; `vectorRef` points at wherever the vector is.
 */
export interface Embedding {
  id: string
  targetType: string
  targetId: string
  provider: string
  model: string
  dimension: number
  sourceHash: string
  status: EmbeddingStatus
  vectorRef: string | null
  createdAt: string
  updatedAt: string
  error: string | null
}

export const EmbeddingSchema: z.ZodType<Embedding> = z.object({
  id: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  provider: z.string(),
  model: z.string(),
  dimension: z.number().int(),
  sourceHash: z.string(),
  status: EmbeddingStatusSchema,
  vectorRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
})
