import { authedProcedure, router } from '../trpc'

/**
 * `index` router (plan §15.2): rebuild / status. Derived indexes are
 * droppable/regenerable from canonical rows (plan §12.2).
 */
export const indexRouter = router({
  /** Rebuild derived indexes (FTS + vectors when configured) -> `naru.reindex`. */
  rebuild: authedProcedure.mutation(async ({ ctx }) => {
    await ctx.naru.reindex()
    return { ok: true as const }
  }),

  /** Basic index freshness snapshot -> `naru.indexStatus` (plan §11.10). */
  status: authedProcedure.query(({ ctx }) => ctx.naru.indexStatus()),
})
