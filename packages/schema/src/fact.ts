import { z } from 'zod'

/** Fact lifecycle status values (plan §11.5). */
export const FACT_STATUSES = ['active', 'superseded', 'deleted', 'rejected', 'archived'] as const

export type FactStatus = (typeof FACT_STATUSES)[number]

export const FactStatusSchema = z.enum(FACT_STATUSES)

/**
 * The main memory unit (plan §11.5).
 *
 * A fact is a (subject, predicate, object) triple plus a human-readable
 * `statement`. The object is either an entity reference (`objectEntityId`) or
 * a literal (`objectValue`). `statementHash` is the portable content hash from
 * `statementHash()` used for cross-machine dedupe.
 */
export interface Fact {
  id: string
  scopeId: string
  subjectEntityId: string | null
  predicate: string
  objectEntityId: string | null
  objectValue: string | null
  statement: string
  statementHash: string
  confidence: number
  status: FactStatus
  validFrom: string | null
  validTo: string | null
  observedAt: string
  createdAt: string
  updatedAt: string
  metadata: Record<string, unknown>
}

export const FactSchema: z.ZodType<Fact> = z.object({
  id: z.string(),
  scopeId: z.string(),
  subjectEntityId: z.string().nullable(),
  predicate: z.string(),
  objectEntityId: z.string().nullable(),
  objectValue: z.string().nullable(),
  statement: z.string(),
  statementHash: z.string(),
  confidence: z.number(),
  status: FactStatusSchema,
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  observedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.unknown()),
})
