import { ScopeTypeSchema } from '@naru/schema'
import { z } from 'zod'
import { authedProcedure, router } from '../trpc'

/**
 * Scope type that may be created as a row. `global` is excluded: per plan §9.1
 * it is a query-time alias (a read-set expansion), never a stored scope row or
 * write target, so `scope.resolve` must reject it.
 */
const ResolvableScopeTypeSchema = ScopeTypeSchema.exclude(['global'])

/**
 * `scope` router (plan §15.2): list / resolve.
 *
 * `resolve` is get-or-create of a `(type, key)` scope row (plan §11.2). It is a
 * mutation because it may create a row. Listing is a read.
 */
export const scopeRouter = router({
  /** List all known scopes -> `naru.listScopes` (plan §15.2). */
  list: authedProcedure.query(({ ctx }) => ctx.naru.listScopes()),

  /** Resolve (get-or-create) a scope by `(type, key)` -> `naru.ensureScope`. */
  resolve: authedProcedure
    .input(
      z.object({
        type: ResolvableScopeTypeSchema,
        key: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.naru.ensureScope(input.type, input.key, input.name)),
})
