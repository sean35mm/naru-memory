import { z } from 'zod'

/**
 * Non-destructive fact replacement link (plan §11.8, §13.6).
 *
 * Records that `newFactId` replaces `oldFactId`. The old fact is marked
 * `superseded` (not deleted); the current view returns the new fact while the
 * history view can show both. Supersession is for memory evolution, not
 * privacy deletion (plan §18.2).
 */
export interface Supersession {
  id: string
  oldFactId: string
  newFactId: string
  reason: string | null
  confidence: number | null
  createdAt: string
}

export const SupersessionSchema: z.ZodType<Supersession> = z.object({
  id: z.string(),
  oldFactId: z.string(),
  newFactId: z.string(),
  reason: z.string().nullable(),
  confidence: z.number().nullable(),
  createdAt: z.string(),
})
