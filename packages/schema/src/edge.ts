import { z } from 'zod'

/**
 * Typed graph edge for traversal (plan §11.7).
 *
 * Connects two nodes (facts/entities/etc.) identified by a `(type, id)` pair
 * within a scope. Traversal must re-filter collected facts by allowed scope at
 * every hop (plan §18.3).
 */
export interface Edge {
  id: string
  scopeId: string
  sourceType: string
  sourceId: string
  predicate: string
  targetType: string
  targetId: string
  confidence: number | null
  metadata: Record<string, unknown>
  createdAt: string
}

export const EdgeSchema: z.ZodType<Edge> = z.object({
  id: z.string(),
  scopeId: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  predicate: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  confidence: z.number().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
})
