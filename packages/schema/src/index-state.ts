import { z } from 'zod'

/** Derived-index freshness status. */
export const INDEX_STATUSES = ['fresh', 'stale', 'rebuilding', 'error'] as const

export type IndexStatus = (typeof INDEX_STATUSES)[number]

export const IndexStatusSchema = z.enum(INDEX_STATUSES)

/**
 * Tracks freshness of a derived index (FTS, entity index, etc.) (plan §11.10).
 * Keyed by `indexName`. Derived indexes are droppable and regenerable from the
 * canonical tables (plan §12.2).
 */
export interface IndexState {
  indexName: string
  indexVersion: string
  sourceWatermark: string | null
  sourceHash: string | null
  status: IndexStatus
  lastRebuiltAt: string | null
  error: string | null
  metadata: Record<string, unknown>
}

export const IndexStateSchema: z.ZodType<IndexState> = z.object({
  indexName: z.string(),
  indexVersion: z.string(),
  sourceWatermark: z.string().nullable(),
  sourceHash: z.string().nullable(),
  status: IndexStatusSchema,
  lastRebuiltAt: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.unknown()),
})
