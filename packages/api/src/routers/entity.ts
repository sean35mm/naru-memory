import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { ScopeSelectorSchema } from '../schemas'
import { authedProcedure, router } from '../trpc'

/**
 * `entity` router (plan §15.2): list / get. Backed by the minimal core entity
 * accessors (`naru.listEntities` / `naru.getEntity`).
 */
export const entityRouter = router({
  /** List entities, optionally scoped -> `naru.listEntities` (plan §15.2). */
  list: authedProcedure
    .input(z.object({ scope: ScopeSelectorSchema.optional() }).optional())
    .query(({ ctx, input }) => ctx.naru.listEntities(input?.scope)),

  /** Get one entity with linked active facts -> `naru.getEntity`; NOT_FOUND if absent. */
  get: authedProcedure.input(z.object({ id: z.string().min(1) })).query(({ ctx, input }) => {
    const found = ctx.naru.getEntity(input.id)
    if (!found) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `entity not found: ${input.id}` })
    }
    return found
  }),
})
