import { z } from 'zod'

/** Canonical entity types (plan §11.4). */
export const ENTITY_TYPES = [
  'person',
  'repo',
  'project',
  'file',
  'tool',
  'concept',
  'task',
  'system',
  'organization',
] as const

export type EntityType = (typeof ENTITY_TYPES)[number]

export const EntityTypeSchema = z.enum(ENTITY_TYPES)

/**
 * Canonical named thing (plan §11.4).
 *
 * Scoping policy: entities are per-scope by default, so `scopeId` is normally
 * populated. A `null` `scopeId` denotes an explicitly promoted global/shared
 * entity — the exception, never the default (plan §11.4, §18.3). Promotion
 * shares entity identity only; attached facts retain their own scope.
 */
export interface Entity {
  id: string
  scopeId: string | null
  type: EntityType
  canonicalName: string
  /** Normalized matching key (lowercased/whitespace-collapsed canonical name). */
  normalizedKey: string
  aliases: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export const EntitySchema: z.ZodType<Entity> = z.object({
  id: z.string(),
  scopeId: z.string().nullable(),
  type: EntityTypeSchema,
  canonicalName: z.string(),
  normalizedKey: z.string(),
  aliases: z.array(z.string()),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
