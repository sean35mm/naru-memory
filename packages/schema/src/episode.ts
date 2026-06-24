import { z } from 'zod'
import { type RetentionMode, RetentionModeSchema } from './retention'

/** Source types for captured episodes (plan §13.1). */
export const SOURCE_TYPES = [
  'chat',
  'tool',
  'summary',
  'import',
  'manual',
  'document',
  'system',
] as const

export type SourceType = (typeof SOURCE_TYPES)[number]

export const SourceTypeSchema = z.enum(SOURCE_TYPES)

/**
 * Captured source material (plan §11.3).
 *
 * Domain fields are camelCase; the store layer maps them to the snake_case
 * columns and JSON-serializes `metadata` into `metadata_json`.
 */
export interface Episode {
  id: string
  scopeId: string
  sourceType: SourceType
  sourceRef: string | null
  sourceHash: string
  /** Optional keyed HMAC over the source for tamper-evident provenance. */
  hmacHash: string | null
  retentionMode: RetentionMode
  /** Redacted episode body; null under `minimal`/`none` retention. */
  redactedText: string | null
  metadata: Record<string, unknown>
  observedAt: string
  createdAt: string
}

export const EpisodeSchema: z.ZodType<Episode> = z.object({
  id: z.string(),
  scopeId: z.string(),
  sourceType: SourceTypeSchema,
  sourceRef: z.string().nullable(),
  sourceHash: z.string(),
  hmacHash: z.string().nullable(),
  retentionMode: RetentionModeSchema,
  redactedText: z.string().nullable(),
  metadata: z.record(z.unknown()),
  observedAt: z.string(),
  createdAt: z.string(),
})
