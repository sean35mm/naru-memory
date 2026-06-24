import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { authedProcedure, router } from '../trpc'

/**
 * `fact` router (plan §15.2): get / supersede.
 *
 * `fact.neighborhood` (graph traversal) is intentionally NOT implemented here —
 * it is deferred to M3+ (plan §15.2, graph neighborhood). Leave the seam.
 */
export const factRouter = router({
  /** Retrieve one fact with evidence -> `naru.get`; NOT_FOUND if absent. */
  get: authedProcedure.input(z.object({ id: z.string().min(1) })).query(({ ctx, input }) => {
    const found = ctx.naru.get(input.id)
    if (!found) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `fact not found: ${input.id}` })
    }
    return found
  }),

  /** Manually supersede `oldId` with `newId` -> `naru.supersede` (plan §13.6). */
  supersede: authedProcedure
    .input(
      z.object({
        oldId: z.string().min(1),
        newId: z.string().min(1),
        reason: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      try {
        return ctx.naru.supersede(input.oldId, input.newId, input.reason)
      } catch (err) {
        // Core throws on a missing old/new fact; surface as NOT_FOUND.
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: err instanceof Error ? err.message : 'supersede failed',
          cause: err,
        })
      }
    }),
})
